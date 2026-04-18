#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findConfigFile, loadConfig, resolveConfigDir } from './config.js';
import { resolveAllThemes } from './registry.js';
import { classifyTheme } from './classifier.js';
import { runAll } from './orchestrator.js';
import { resetBreaker, readBreaker } from './safety.js';
import { buildDashboard, notifySlack } from './report.js';
import { judgePacket } from './judge.js';
import { loadRubric } from './rubric.js';
import { initWorkspace } from './init.js';
import { nanoid } from './util.js';
import type { ThemeDoctorConfig, ThemeEntry } from './types.js';

const execFileAsync = promisify(execFile);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireConfig(configPath?: string): { config: ThemeDoctorConfig; configDir: string; configFile: string } {
  const configFile = configPath
    ? path.resolve(configPath)
    : findConfigFile();

  if (!configFile) {
    console.error(chalk.red('No theme-doctor.yaml found. Run `theme-doctor init` first.'));
    process.exit(1);
  }

  const config    = loadConfig(configFile);
  const configDir = resolveConfigDir(configFile);
  return { config, configDir, configFile };
}

function cacheDir(configDir: string): string {
  return path.join(configDir, '.theme-doctor');
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('theme-doctor')
  .description('AI-powered WooCommerce theme QA — crawl, judge, and auto-fix any registered theme set.')
  .version('0.1.0')
  .option('--config <path>', 'Path to theme-doctor.yaml');

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold theme-doctor.yaml + rubric/ + blueprints/ in current directory')
  .option('--force', 'Overwrite existing files')
  .action(async (opts: { force?: boolean }) => {
    const spinner = ora('Initialising Theme Doctor workspace…').start();
    try {
      await initWorkspace(process.cwd(), { force: opts.force ?? false });
      spinner.succeed(chalk.green('Workspace ready. Edit theme-doctor.yaml to register your themes.'));
      console.log(chalk.dim('  theme-doctor.yaml       ← main config'));
      console.log(chalk.dim('  rubric/templates.yaml   ← template checks'));
      console.log(chalk.dim('  rubric/flows.yaml       ← multi-step flows'));
      console.log(chalk.dim('  blueprints/base.json    ← WP+WC blueprint'));
    } catch (err: unknown) {
      spinner.fail(chalk.red((err instanceof Error ? err.message : String(err))));
      process.exit(1);
    }
  });

// ─── add ──────────────────────────────────────────────────────────────────────

program
  .command('add <path-or-url>')
  .description('Register a theme (local path, git URL, or zip URL)')
  .option('--id <id>', 'Override theme ID')
  .action(async (target: string, opts: { id?: string }) => {
    const { config, configFile } = requireConfig(program.opts().config);

    let source: ThemeEntry['source'];
    if (target.startsWith('http') && target.endsWith('.git')) {
      source = { type: 'git', url: target, ref: 'main' };
    } else if (target.startsWith('http') && target.endsWith('.zip')) {
      source = { type: 'zip', url: target };
    } else if (target.startsWith('http')) {
      source = { type: 'git', url: target };
    } else {
      source = { type: 'path', path: path.resolve(target) };
    }

    const id = opts.id ?? (source.type === 'path'
      ? path.basename(path.resolve(target))
      : source.type === 'git' ? path.basename(target, '.git') : path.basename(target, '.zip'));

    if (config.themes.some(t => t.id === id)) {
      console.log(chalk.yellow(`Theme "${id}" is already registered.`));
      return;
    }

    config.themes.push({ id, source });
    const { stringify } = await import('yaml');
    await fsp.writeFile(configFile, stringify(config, { lineWidth: 120 }));
    console.log(chalk.green(`Added theme "${id}".`));
  });

// ─── list ─────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('Print registered themes and their last known status')
  .action(async () => {
    const { config, configDir } = requireConfig(program.opts().config);
    const themes = await resolveAllThemes(config, configDir, cacheDir(configDir));

    if (themes.length === 0) {
      console.log(chalk.yellow('No themes registered. Run `theme-doctor add <path>` to add one.'));
      return;
    }

    const { table } = await import('table');
    const rows = [['ID', 'Type', 'Path', 'Sandbox', 'Breaker']];
    for (const t of themes) {
      const breaker = await readBreaker(configDir, t.id);
      rows.push([
        t.id,
        t.source.type,
        t.localPath,
        t.sandbox,
        breaker.tripped ? chalk.red('TRIPPED') : chalk.green('ok'),
      ]);
    }
    console.log(table(rows));
  });

// ─── classify ────────────────────────────────────────────────────────────────

program
  .command('classify <id>')
  .description('Run the theme classifier and print results')
  .action(async (id: string) => {
    const { config, configDir } = requireConfig(program.opts().config);
    const themes = await resolveAllThemes(config, configDir, cacheDir(configDir));
    const theme = themes.find(t => t.id === id);
    if (!theme) {
      console.error(chalk.red(`Theme "${id}" not found.`));
      process.exit(1);
    }
    const spinner = ora(`Classifying ${id}…`).start();
    const result = await classifyTheme(theme.localPath);
    spinner.succeed();
    console.log(JSON.stringify(result, null, 2));
  });

// ─── run ──────────────────────────────────────────────────────────────────────

program
  .command('run')
  .description('Full pipeline: crawl → judge → fix → PR')
  .option('--theme <id>', 'Run only a specific theme')
  .option('--sandbox <type>', 'Override sandbox: playground|wp-env|auto')
  .option('--dry-run', 'Do not create PRs or modify any files')
  .option('--shadow', 'Shadow mode: PRs created as drafts, no auto-merge')
  .option('--skip-cache', 'Ignore cache and re-run everything')
  .action(async (opts: {
    theme?: string;
    sandbox?: string;
    dryRun?: boolean;
    shadow?: boolean;
    skipCache?: boolean;
  }) => {
    const { config, configDir } = requireConfig(program.opts().config);
    let themes = await resolveAllThemes(config, configDir, cacheDir(configDir));

    if (opts.theme) {
      themes = themes.filter(t => t.id === opts.theme);
      if (themes.length === 0) {
        console.error(chalk.red(`Theme "${opts.theme}" not found.`));
        process.exit(1);
      }
    }

    const maxCostUsd = config.defaults?.budget?.max_cost_usd_per_run ?? 5;

    const spinner = ora(`Running Theme Doctor on ${themes.length} theme(s)…`).start();

    try {
      const reports = await runAll(themes, {
        configDir,
        dryRun:     opts.dryRun ?? false,
        shadowMode: opts.shadow ?? false,
        sandbox:    opts.sandbox as 'playground' | 'wp-env' | 'auto' | undefined,
        maxCostUsd,
        skipCache:  opts.skipCache ?? false,
      });

      const pass     = reports.filter(r => r.verdict === 'pass').length;
      const fail     = reports.length - pass;

      spinner.stop();
      console.log(chalk.bold(`\nResults: ${pass} passed, ${fail} failed (${reports.length} total)`));

      for (const r of reports) {
        const icon = r.verdict === 'pass' ? chalk.green('✅') : chalk.red('❌');
        const issues = r.judgements.filter(j => j.verdict !== 'pass').length;
        console.log(`  ${icon} ${r.themeId} [WP ${r.matrix.wp}/WC ${r.matrix.wc}/PHP ${r.matrix.php}] — ${r.verdict}${issues > 0 ? ` (${issues} issues)` : ''}${r.prUrl ? ` → ${r.prUrl}` : ''}`);
      }

      // Save run report
      const runId = reports[0]?.runId ?? nanoid();
      const reportDir = path.join(configDir, 'reports', runId);
      await fsp.mkdir(reportDir, { recursive: true });
      await fsp.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(reports, null, 2));

      // Slack notification
      const slackWebhook = config.integrations?.slack?.webhook_url_env
        ? process.env[config.integrations.slack.webhook_url_env]
        : undefined;
      if (slackWebhook) {
        await notifySlack(slackWebhook, reports).catch(() => undefined);
      }
    } catch (err: unknown) {
      spinner.fail(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ─── crawl ────────────────────────────────────────────────────────────────────

program
  .command('crawl <id>')
  .description('Crawl a theme and emit evidence packet (no judging or fixing)')
  .option('--sandbox <type>', 'Override sandbox type')
  .action(async (id: string, _opts: { sandbox?: string }) => {
    const { config, configDir } = requireConfig(program.opts().config);
    const themes = await resolveAllThemes(config, configDir, cacheDir(configDir));
    const theme = themes.find(t => t.id === id);
    if (!theme) {
      console.error(chalk.red(`Theme "${id}" not found.`));
      process.exit(1);
    }

    const runId = nanoid();
    const spinner = ora(`Crawling ${id}…`).start();

    try {
      const { createSandbox } = await import('./sandbox/index.js');
      const { crawlTheme } = await import('./crawler.js');
      const blueprintPath = path.join(configDir, 'blueprints', 'base.json');
      const workDir = path.join(configDir, '.theme-doctor', 'work', runId);
      await fsp.mkdir(workDir, { recursive: true });

      const cell = { wp: theme.matrix.wp[0]!, wc: theme.matrix.wc[0]!, php: theme.matrix.php[0]! };
      const sandbox = await createSandbox(theme, cell, {
        configDir,
        blueprintPath,
        workDir,
      });

      const boot = await sandbox.boot(theme, cell);
      const rubric = await loadRubric(configDir);
      const ctx = {
        runId,
        themeId: theme.id,
        theme,
        matrix: cell,
        sandbox: 'playground' as const,
        configDir,
        workDir,
        dryRun: true,
        shadowMode: false,
        startedAt: new Date().toISOString(),
      };

      try {
        const packet = await crawlTheme(ctx, boot, rubric, theme.viewports);
        const outDir = path.join(configDir, 'reports', runId);
        await fsp.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, 'evidence.json');
        await fsp.writeFile(outPath, JSON.stringify(packet, null, 2));
        spinner.succeed(`Evidence packet written to ${outPath} (${packet.captures.length} captures)`);
      } finally {
        await boot.shutdown();
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (err: unknown) {
      spinner.fail(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// ─── judge ────────────────────────────────────────────────────────────────────

program
  .command('judge <run-id>')
  .description('Re-judge an existing crawl run (no re-crawl)')
  .action(async (runId: string) => {
    const { configDir } = requireConfig(program.opts().config);
    const evidencePath = path.join(configDir, 'reports', runId, 'evidence.json');
    if (!fs.existsSync(evidencePath)) {
      console.error(chalk.red(`No evidence packet found for run "${runId}".`));
      process.exit(1);
    }

    const spinner = ora(`Judging run ${runId}…`).start();
    const packet  = JSON.parse(await fsp.readFile(evidencePath, 'utf8'));
    const rubric  = await loadRubric(configDir);
    const result  = await judgePacket(packet, configDir, rubric);

    spinner.succeed();
    console.log(`Overall: ${result.overallVerdict} (${result.passCount} pass, ${result.failCount} fail)`);
    for (const v of result.verdicts.filter(x => x.verdict !== 'pass')) {
      console.log(`  ❌ ${v.templateId}@${v.viewport}px — ${v.verdict} [${v.tier}]: ${v.evidence.join('; ')}`);
    }

    const outPath = path.join(configDir, 'reports', runId, 'judgement.json');
    await fsp.writeFile(outPath, JSON.stringify(result, null, 2));
    console.log(chalk.dim(`Judgement saved to ${outPath}`));
  });

// ─── fix ──────────────────────────────────────────────────────────────────────

program
  .command('fix <id>')
  .description('Invoke triage → patch → verify on the latest failing run for a theme')
  .option('--dry-run', 'Show fix plan but do not apply changes')
  .action(async (id: string, opts: { dryRun?: boolean }) => {
    const { config, configDir } = requireConfig(program.opts().config);
    const themes = await resolveAllThemes(config, configDir, cacheDir(configDir));
    const theme = themes.find(t => t.id === id);
    if (!theme) {
      console.error(chalk.red(`Theme "${id}" not found.`));
      process.exit(1);
    }

    // Find latest judgement for this theme
    const reportsDir = path.join(configDir, 'reports');
    let latestJudgement = null;
    if (fs.existsSync(reportsDir)) {
      const runs = (await fsp.readdir(reportsDir)).sort().reverse();
      for (const run of runs) {
        const jp = path.join(reportsDir, run, 'judgement.json');
        if (fs.existsSync(jp)) {
          const j = JSON.parse(await fsp.readFile(jp, 'utf8'));
          if (j.themeId === id) { latestJudgement = j; break; }
        }
      }
    }

    if (!latestJudgement) {
      console.error(chalk.red(`No judgement found for "${id}". Run \`theme-doctor crawl ${id}\` and \`theme-doctor judge <run-id>\` first.`));
      process.exit(1);
    }

    const spinner = ora(`Triaging ${id}…`).start();
    const { runTriageAgent } = await import('./fixer/triage.js');
    const { runPatchAgent } = await import('./fixer/patch.js');

    const plan = await runTriageAgent(latestJudgement, theme.localPath, configDir);
    spinner.text = 'Triage complete.';

    console.log(chalk.bold('\nTriage plan:'));
    console.log(`  Hypothesis: ${plan.hypothesis}`);
    console.log(`  Files to touch: ${plan.filesToTouch.map(f => f.relativePath).join(', ')}`);
    console.log(`  Risk class: ${plan.riskClass}`);

    if (opts.dryRun) {
      spinner.succeed('Dry run — no changes applied.');
      return;
    }

    spinner.text = 'Patching…';
    const patch = await runPatchAgent(plan, theme.localPath, configDir);
    spinner.succeed(patch.success
      ? chalk.green(`Patched ${patch.filesChanged.length} file(s)`)
      : chalk.yellow('No changes applied.'));

    if (patch.filesChanged.length > 0) {
      console.log('Changed files:');
      for (const f of patch.filesChanged) console.log(`  ${f}`);
      console.log(chalk.dim(`Patch written to ${patch.patchPath}`));
    }
  });

// ─── repro ────────────────────────────────────────────────────────────────────

program
  .command('repro')
  .description('Reproduce a customer bug: boot theme, attempt repro, write evidence')
  .requiredOption('--theme <id>', 'Theme ID')
  .requiredOption('--url <pattern>', 'URL path pattern, e.g. /cart')
  .requiredOption('--description <text>', 'Bug description')
  .option('--fix', 'Attempt auto-fix after repro')
  .action(async (opts: { theme: string; url: string; description: string; fix?: boolean }) => {
    const { config, configDir } = requireConfig(program.opts().config);
    const themes = await resolveAllThemes(config, configDir, cacheDir(configDir));
    const theme = themes.find(t => t.id === opts.theme);
    if (!theme) {
      console.error(chalk.red(`Theme "${opts.theme}" not found.`));
      process.exit(1);
    }

    const spinner = ora(`Reproducing bug on ${opts.theme}: "${opts.description}"…`).start();

    const runId = nanoid();
    const workDir = path.join(configDir, '.theme-doctor', 'work', runId);
    await fsp.mkdir(workDir, { recursive: true });

    const { createSandbox } = await import('./sandbox/index.js');
    const { crawlTheme } = await import('./crawler.js');
    const blueprintPath = path.join(configDir, 'blueprints', 'base.json');

    const cell = { wp: theme.matrix.wp[0]!, wc: theme.matrix.wc[0]!, php: theme.matrix.php[0]! };
    const sandbox = await createSandbox(theme, cell, { configDir, blueprintPath, workDir });
    const boot = await sandbox.boot(theme, cell);

    const reproRubric = {
      templates: [{
        id: 'repro',
        name: `Repro: ${opts.description.slice(0, 50)}`,
        urlPattern: opts.url,
        selectors: [],
      }],
      flows: [],
    };

    const ctx = {
      runId,
      themeId: theme.id,
      theme,
      matrix: cell,
      sandbox: 'playground' as const,
      configDir,
      workDir,
      dryRun: !opts.fix,
      shadowMode: true,
      startedAt: new Date().toISOString(),
    };

    try {
      const packet = await crawlTheme(ctx, boot, reproRubric, theme.viewports);
      const outDir = path.join(configDir, 'reports', runId);
      await fsp.mkdir(outDir, { recursive: true });

      // Write repro report
      const reportPath = path.join(outDir, 'repro.json');
      await fsp.writeFile(reportPath, JSON.stringify({
        themeId: opts.theme,
        url: opts.url,
        description: opts.description,
        runId,
        captures: packet.captures.length,
        errors: packet.captures.flatMap(c => c.consoleMessages.filter(m => m.type === 'error')),
        screenshots: packet.captures.map(c => c.screenshotPath),
      }, null, 2));

      spinner.succeed(`Repro complete. Evidence at ${outDir}`);
      console.log(`  Screenshots: ${packet.captures.length}`);
      console.log(`  Errors: ${packet.captures.flatMap(c => c.consoleMessages.filter(m => m.type === 'error')).length}`);
    } finally {
      await boot.shutdown();
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

// ─── reset ────────────────────────────────────────────────────────────────────

program
  .command('reset <id>')
  .description('Clear circuit breaker for a theme')
  .action(async (id: string) => {
    const { configDir } = requireConfig(program.opts().config);
    await resetBreaker(configDir, id);
    console.log(chalk.green(`Circuit breaker reset for "${id}".`));
  });

// ─── goldens ─────────────────────────────────────────────────────────────────

const goldensCmd = program.command('goldens').description('Manage golden baselines');

goldensCmd
  .command('approve <id>')
  .description('Mark pending goldens as approved for a theme')
  .action(async (id: string) => {
    const { configDir } = requireConfig(program.opts().config);
    const pendingPath = path.join(configDir, 'goldens', id, '.pending');
    if (!fs.existsSync(pendingPath)) {
      console.log(chalk.yellow(`No pending goldens for "${id}".`));
      return;
    }
    await fsp.unlink(pendingPath);
    console.log(chalk.green(`Goldens approved for "${id}".`));
  });

goldensCmd
  .command('list')
  .description('List themes with goldens')
  .action(async () => {
    const { configDir } = requireConfig(program.opts().config);
    const goldensDir = path.join(configDir, 'goldens');
    if (!fs.existsSync(goldensDir)) {
      console.log('No goldens yet.');
      return;
    }
    const themes = await fsp.readdir(goldensDir);
    for (const t of themes) {
      const matrixDirs = await fsp.readdir(path.join(goldensDir, t));
      console.log(`  ${t}: ${matrixDirs.join(', ')}`);
    }
  });

// ─── dashboard ───────────────────────────────────────────────────────────────

const dashCmd = program.command('dashboard').description('Build or view the static dashboard');

dashCmd
  .command('build')
  .description('Build static dashboard from local reports')
  .action(async () => {
    const { configDir } = requireConfig(program.opts().config);
    const spinner = ora('Building dashboard…').start();
    const indexPath = await buildDashboard(configDir);
    spinner.succeed(chalk.green(`Dashboard built at ${indexPath}`));

    const open = (await import('open')).default;
    await open(indexPath).catch(() => undefined);
  });

// ─── doctor ───────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Self-check: verify deps, tokens, sandbox, gh auth')
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; note?: string }> = [];

    // Node version
    const nodeOk = parseInt(process.versions.node.split('.')[0]!, 10) >= 20;
    checks.push({ name: 'Node >= 20', ok: nodeOk, note: process.versions.node });

    // ANTHROPIC_API_KEY
    checks.push({ name: 'ANTHROPIC_API_KEY', ok: !!process.env.ANTHROPIC_API_KEY, note: process.env.ANTHROPIC_API_KEY ? '(set)' : '(not set — AI judge/fixer disabled)' });

    // GH_TOKEN or gh auth
    const ghToken = !!process.env.GH_TOKEN;
    let ghAuth = false;
    try {
      await execFileAsync('gh', ['auth', 'status']);
      ghAuth = true;
    } catch { /* not authed */ }
    checks.push({ name: 'GitHub auth (GH_TOKEN or gh auth)', ok: ghToken || ghAuth, note: ghToken ? '(token)' : ghAuth ? '(gh auth)' : '(not set — PRs disabled)' });

    // Playwright
    let playwrightOk = false;
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      playwrightOk = true;
    } catch { /* not available */ }
    checks.push({ name: 'Playwright / Chromium', ok: playwrightOk, note: playwrightOk ? '' : 'Run: npx playwright install chromium' });

    // wp-playground
    let playgroundOk = false;
    try {
      await execFileAsync('wp-playground', ['--version']);
      playgroundOk = true;
    } catch { /* not available */ }
    checks.push({ name: '@wp-playground/cli (wp-playground)', ok: playgroundOk, note: playgroundOk ? '' : 'Optional: npm i -g @wp-playground/cli' });

    // odiff
    let odiffOk = false;
    try {
      await execFileAsync('odiff', ['--help']);
      odiffOk = true;
    } catch { /* not available */ }
    checks.push({ name: 'odiff (pixel diff)', ok: odiffOk, note: odiffOk ? '' : 'Optional — pixel diff tier disabled without it' });

    // Config
    const configFile = findConfigFile();
    checks.push({ name: 'theme-doctor.yaml', ok: !!configFile, note: configFile ?? 'Run `theme-doctor init`' });

    console.log(chalk.bold('\n🩺 Theme Doctor — self check\n'));
    for (const c of checks) {
      const icon = c.ok ? chalk.green('✅') : chalk.yellow('⚠️ ');
      console.log(`  ${icon}  ${c.name}${c.note ? chalk.dim('  ' + c.note) : ''}`);
    }
    console.log('');

    const allRequired = checks.filter(c => c.name !== '@wp-playground/cli (wp-playground)' && c.name !== 'odiff (pixel diff)' && c.name !== 'GitHub auth (GH_TOKEN or gh auth)' && c.name !== 'theme-doctor.yaml');
    if (allRequired.every(c => c.ok)) {
      console.log(chalk.green('All required checks passed.'));
    } else {
      console.log(chalk.yellow('Some required checks failed. See above.'));
    }
  });

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
