import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from './util.js';
import type {
  ResolvedTheme,
  RunContext,
  RunJudgement,
  ThemeRunReport,
} from './types.js';
import { createSandbox } from './sandbox/index.js';
import { crawlTheme } from './crawler.js';
import { judgePacket, bootstrapGoldens, goldensExist } from './judge.js';
import { runTriageAgent } from './fixer/triage.js';
import { runPatchAgent } from './fixer/patch.js';
import { runVerifyAgent } from './fixer/verify.js';
import { loadRubric } from './rubric.js';
import { readBreaker, recordSuccess, recordFailure, tagLastKnownGood } from './safety.js';
import { createPr } from './report.js';
import type { SandboxOptions } from './sandbox/types.js';
import { getThemeCommitSha } from './registry.js';

export interface RunOptions {
  configDir:      string;
  dryRun:         boolean;
  shadowMode:     boolean;
  sandbox?:       'playground' | 'wp-env' | 'auto';
  maxCostUsd?:    number;
  skipCache?:     boolean;
}

const MAX_FIX_ATTEMPTS = 3;

// ─── Cache ────────────────────────────────────────────────────────────────────

function cacheKeyFor(
  themeCommit: string,
  blueprintSha: string,
  matrix: { wp: string; wc: string; php: string },
  overlays: string[],
): string {
  const raw = `${themeCommit}|${blueprintSha}|${matrix.wp}|${matrix.wc}|${matrix.php}|${overlays.sort().join(',')}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

async function blueprintSha(blueprintPath: string): Promise<string> {
  if (!fs.existsSync(blueprintPath)) return 'none';
  const content = await fsp.readFile(blueprintPath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function cacheFile(configDir: string, key: string): string {
  return path.join(configDir, '.theme-doctor', 'cache', `${key}.json`);
}

async function isCacheHit(configDir: string, key: string): Promise<boolean> {
  const f = cacheFile(configDir, key);
  if (!fs.existsSync(f)) return false;
  const data = JSON.parse(await fsp.readFile(f, 'utf8'));
  return data.verdict === 'pass';
}

async function writeCacheEntry(configDir: string, key: string, verdict: string): Promise<void> {
  const f = cacheFile(configDir, key);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify({ verdict, ts: new Date().toISOString() }));
}

// ─── Run a single theme × matrix cell ────────────────────────────────────────

export async function runThemeCell(
  theme: ResolvedTheme,
  matrixCell: { wp: string; wc: string; php: string },
  opts: RunOptions,
): Promise<ThemeRunReport> {
  const runId = nanoid();
  const start = Date.now();

  const blueprintPath = path.join(opts.configDir, 'blueprints', 'base.json');
  const bpSha  = await blueprintSha(blueprintPath);
  const commit = await getThemeCommitSha(theme.localPath);
  const cacheKey = cacheKeyFor(commit, bpSha, matrixCell, []);

  // Cache check
  if (!opts.skipCache && await isCacheHit(opts.configDir, cacheKey)) {
    return {
      runId,
      themeId:   theme.id,
      matrix:    matrixCell,
      verdict:   'pass',
      judgements: [],
      durationMs: Date.now() - start,
      costUsd:    0,
      createdAt:  new Date().toISOString(),
    };
  }

  // Circuit breaker check
  const breaker = await readBreaker(opts.configDir, theme.id);
  if (breaker.tripped) {
    throw new Error(`Circuit breaker tripped for theme "${theme.id}". Run \`theme-doctor reset ${theme.id}\` to re-enable.`);
  }

  // Build context
  const workDir = path.join(opts.configDir, '.theme-doctor', 'work', runId);
  await fsp.mkdir(workDir, { recursive: true });

  const ctx: RunContext = {
    runId,
    themeId:    theme.id,
    theme,
    matrix:     matrixCell,
    sandbox:    opts.sandbox === 'playground' || opts.sandbox === 'wp-env'
      ? opts.sandbox
      : 'playground',
    configDir:  opts.configDir,
    workDir,
    dryRun:     opts.dryRun,
    shadowMode: opts.shadowMode,
    startedAt:  new Date().toISOString(),
  };

  const sandboxOpts: SandboxOptions = {
    configDir:    opts.configDir,
    blueprintPath,
    workDir,
  };

  const sandbox = await createSandbox(theme, matrixCell, sandboxOpts);
  const boot = await sandbox.boot(theme, matrixCell);

  let report: ThemeRunReport;

  try {
    const rubric = await loadRubric(opts.configDir);

    // Crawl
    const packet = await crawlTheme(ctx, boot, rubric, theme.viewports);

    // Bootstrap goldens if first run
    const hasGoldens = await goldensExist(opts.configDir, theme.id, matrixCell.wp, matrixCell.wc);
    if (!hasGoldens) {
      await bootstrapGoldens(packet, opts.configDir);
      report = {
        runId,
        themeId:    theme.id,
        matrix:     matrixCell,
        verdict:    'pass',
        judgements: [],
        durationMs: Date.now() - start,
        costUsd:    0,
        createdAt:  new Date().toISOString(),
      };
      await writeCacheEntry(opts.configDir, cacheKey, 'pass');
      return report;
    }

    // Judge
    const judgement = await judgePacket(packet, opts.configDir, rubric);

    if (judgement.overallVerdict === 'pass') {
      await recordSuccess(opts.configDir, theme.id);
      await tagLastKnownGood(theme.localPath, theme.id);
      await writeCacheEntry(opts.configDir, cacheKey, 'pass');
      report = {
        runId,
        themeId:    theme.id,
        matrix:     matrixCell,
        verdict:    'pass',
        judgements: judgement.verdicts,
        durationMs: Date.now() - start,
        costUsd:    0,
        createdAt:  new Date().toISOString(),
      };
      return report;
    }

    // Fix loop
    let latestJudgement: RunJudgement = judgement;
    let patchResult;
    let fixAttempts = 0;

    while (latestJudgement.overallVerdict !== 'pass' && fixAttempts < MAX_FIX_ATTEMPTS) {
      fixAttempts++;

      const triagePlan = await runTriageAgent(latestJudgement, theme.localPath, opts.configDir);
      patchResult = await runPatchAgent(triagePlan, theme.localPath, opts.configDir);

      if (!patchResult.success) break;

      const verifyResult = await runVerifyAgent(ctx, boot, rubric, patchResult, latestJudgement);
      latestJudgement = verifyResult.judgement;

      if (verifyResult.passed) break;
    }

    const finalVerdict = latestJudgement.overallVerdict;

    if (finalVerdict !== 'pass') {
      await recordFailure(opts.configDir, theme.id);
    } else {
      await recordSuccess(opts.configDir, theme.id);
      await tagLastKnownGood(theme.localPath, theme.id);
    }

    // Open PR
    let prUrl: string | undefined;
    if (patchResult?.success && !opts.dryRun) {
      prUrl = await createPr(theme, ctx, patchResult, latestJudgement, opts.shadowMode);
    }

    report = {
      runId,
      themeId:    theme.id,
      matrix:     matrixCell,
      verdict:    finalVerdict,
      judgements: latestJudgement.verdicts,
      patchResult,
      prUrl,
      durationMs: Date.now() - start,
      costUsd:    0, // TODO: track real cost from token counts
      createdAt:  new Date().toISOString(),
    };

    if (finalVerdict === 'pass') {
      await writeCacheEntry(opts.configDir, cacheKey, 'pass');
    }

  } finally {
    await boot.shutdown();
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return report;
}

// ─── Run all themes × all matrix cells ────────────────────────────────────────

export async function runAll(
  themes: ResolvedTheme[],
  opts: RunOptions,
): Promise<ThemeRunReport[]> {
  const reports: ThemeRunReport[] = [];

  for (const theme of themes) {
    const cells = expandMatrix(theme.matrix);
    for (const cell of cells) {
      try {
        const report = await runThemeCell(theme, cell, opts);
        reports.push(report);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${theme.id}] Error: ${msg}`);
        reports.push({
          runId:     'error',
          themeId:   theme.id,
          matrix:    cell,
          verdict:   'functional',
          judgements: [],
          durationMs: 0,
          costUsd:   0,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  return reports;
}

function expandMatrix(
  m: { wp: string[]; wc: string[]; php: string[] },
): Array<{ wp: string; wc: string; php: string }> {
  const cells: Array<{ wp: string; wc: string; php: string }> = [];
  for (const wp of m.wp) {
    for (const wc of m.wc) {
      for (const php of m.php) {
        cells.push({ wp, wc, php });
      }
    }
  }
  return cells;
}
