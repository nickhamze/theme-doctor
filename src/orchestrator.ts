import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { atomicWriteFile } from './util.js';

// Pass 20: per-theme serialization lock for circuit breaker and golden bootstrap
// This prevents TOCTOU races when multiple matrix cells run in parallel for the same theme
const _themeSerialLocks = new Map<string, Promise<void>>();

function withThemeLock<T>(themeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _themeSerialLocks.get(themeId) ?? Promise.resolve();
  let resolveLock!: () => void;
  const lock = new Promise<void>(r => { resolveLock = r; });
  _themeSerialLocks.set(themeId, lock);

  return prev.then(() => fn()).finally(() => {
    resolveLock();
    // Clean up map entry if this was the last waiter
    if (_themeSerialLocks.get(themeId) === lock) _themeSerialLocks.delete(themeId);
  });
}
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
  // Bug fix: use async fsp.access instead of sync fs.existsSync
  try {
    await fsp.access(blueprintPath);
  } catch {
    return 'none';
  }
  const content = await fsp.readFile(blueprintPath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function cacheFile(configDir: string, key: string): string {
  return path.join(configDir, '.theme-doctor', 'cache', `${key}.json`);
}

async function isCacheHit(configDir: string, key: string): Promise<boolean> {
  const f = cacheFile(configDir, key);
  try {
    await fsp.access(f);
  } catch {
    return false;
  }
  try {
    const data = JSON.parse(await fsp.readFile(f, 'utf8'));
    return data.verdict === 'pass';
  } catch {
    // Corrupted cache entry — treat as miss
    return false;
  }
}

async function writeCacheEntry(configDir: string, key: string, verdict: string): Promise<void> {
  const f = cacheFile(configDir, key);
  // Pass 13: atomic write
  await atomicWriteFile(f, JSON.stringify({ verdict, ts: new Date().toISOString() }));
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

  // Pass 25: respect per-theme sandbox preference, then CLI override, then auto-detect
  const effectiveSandbox =
    opts.sandbox === 'playground' || opts.sandbox === 'wp-env' ? opts.sandbox
    : theme.sandbox === 'playground' || theme.sandbox === 'wp-env' ? theme.sandbox
    : 'playground'; // default to playground

  const ctx: RunContext = {
    runId,
    themeId:    theme.id,
    theme,
    matrix:     matrixCell,
    sandbox:    effectiveSandbox,
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

  const sandbox = await createSandbox(theme, matrixCell, sandboxOpts, effectiveSandbox);

  // Boot sandbox — if this throws, there is nothing to shut down
  let boot;
  try {
    boot = await sandbox.boot(theme, matrixCell);
  } catch (err) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // Ensure boot is shut down on ALL exit paths (early return or throw)
  let report: ThemeRunReport | undefined;

  try {
    const rubric = await loadRubric(opts.configDir);

    // Crawl
    const packet = await crawlTheme(ctx, boot, rubric, theme.viewports);

    // Pass 20: golden bootstrap serialized per-theme to avoid double-bootstrap race
    const hasGoldens = await goldensExist(opts.configDir, theme.id, matrixCell.wp, matrixCell.wc);
    if (!hasGoldens) {
      await withThemeLock(theme.id, () => bootstrapGoldens(packet, opts.configDir));
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

    // Pass 20: serialize circuit breaker updates per theme to prevent TOCTOU
    if (finalVerdict !== 'pass') {
      await withThemeLock(theme.id, () => recordFailure(opts.configDir, theme.id));
    } else {
      await withThemeLock(theme.id, () => recordSuccess(opts.configDir, theme.id));
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
    await boot.shutdown().catch(() => undefined);
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!report) {
    throw new Error(`[orchestrator] report was never assigned for theme "${theme.id}" — this is a bug`);
  }

  return report;
}

// ─── Run all themes × all matrix cells (parallel with concurrency cap) ────────

const DEFAULT_CONCURRENCY = 4; // sandbox processes per host

export async function runAll(
  themes: ResolvedTheme[],
  opts: RunOptions & { concurrency?: number },
): Promise<ThemeRunReport[]> {
  const limit = pLimit(opts.concurrency ?? DEFAULT_CONCURRENCY);

  const tasks: Array<Promise<ThemeRunReport>> = [];

  for (const theme of themes) {
    const cells = expandMatrix(theme.matrix);
    for (const cell of cells) {
      tasks.push(
        limit(async () => {
          try {
            return await runThemeCell(theme, cell, opts);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[${theme.id}] Error: ${msg}`);
            return {
              runId:      'error',
              themeId:    theme.id,
              matrix:     cell,
              verdict:    'functional' as const,
              judgements: [],
              durationMs: 0,
              costUsd:    0,
              createdAt:  new Date().toISOString(),
            };
          }
        }),
      );
    }
  }

  return Promise.all(tasks);
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
