import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CircuitBreakerState, RunContext } from './types.js';

const BREAKER_MAX_CONSECUTIVE_FAILS = 3;

// ─── Circuit breaker ──────────────────────────────────────────────────────────

function breakerPath(configDir: string, themeId: string): string {
  return path.join(configDir, '.theme-doctor', 'breakers', `${themeId}.json`);
}

export async function readBreaker(configDir: string, themeId: string): Promise<CircuitBreakerState> {
  const p = breakerPath(configDir, themeId);
  if (!fs.existsSync(p)) {
    return { themeId, consecutiveFails: 0, tripped: false };
  }
  const raw = await fsp.readFile(p, 'utf8');
  return JSON.parse(raw) as CircuitBreakerState;
}

export async function writeBreaker(configDir: string, state: CircuitBreakerState): Promise<void> {
  const p = breakerPath(configDir, state.themeId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(state, null, 2));
}

export async function recordSuccess(configDir: string, themeId: string): Promise<void> {
  const state = await readBreaker(configDir, themeId);
  await writeBreaker(configDir, {
    ...state,
    consecutiveFails: 0,
    tripped: false,
  });
}

export async function recordFailure(configDir: string, themeId: string): Promise<CircuitBreakerState> {
  const state = await readBreaker(configDir, themeId);
  const consecutiveFails = state.consecutiveFails + 1;
  const tripped = consecutiveFails >= BREAKER_MAX_CONSECUTIVE_FAILS;
  const next: CircuitBreakerState = {
    ...state,
    consecutiveFails,
    tripped,
    trippedAt: tripped && !state.tripped ? new Date().toISOString() : state.trippedAt,
  };
  await writeBreaker(configDir, next);
  return next;
}

export async function resetBreaker(configDir: string, themeId: string): Promise<void> {
  await writeBreaker(configDir, {
    themeId,
    consecutiveFails: 0,
    tripped: false,
    lastResetAt: new Date().toISOString(),
  });
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export async function appendAuditLog(
  configDir: string,
  themeId: string,
  runId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const logDir = path.join(configDir, 'audit', themeId);
  await fsp.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${runId}.jsonl`);
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
  await fsp.appendFile(logPath, line);
}

// ─── Last-known-good tag ──────────────────────────────────────────────────────

import simpleGit from 'simple-git';

export async function tagLastKnownGood(localPath: string, themeId: string): Promise<void> {
  try {
    const git = simpleGit(localPath);
    const tag = `last-known-good-${themeId}`;
    // Delete existing tag locally if present, then re-create
    try { await git.tag(['-d', tag]); } catch { /* not present */ }
    await git.addTag(tag);
  } catch {
    // Not a fatal error — git might not be available
  }
}

export async function rollbackToLastKnownGood(localPath: string, themeId: string): Promise<void> {
  const git = simpleGit(localPath);
  const tag = `last-known-good-${themeId}`;
  await git.checkout(tag);
}

// ─── Denylist check ───────────────────────────────────────────────────────────

const DENYLIST_PATTERNS = [
  /^style\.css$/,           // theme metadata header
  /^theme\.json$/,          // schema fields
  /package(-lock)?\.json$/, // dependency lockfiles
  /composer\.(json|lock)$/, // PHP dependency lockfiles
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
];

export function isDenylisted(relativePath: string): boolean {
  return DENYLIST_PATTERNS.some(p => p.test(relativePath));
}

// ─── Provenance marker ────────────────────────────────────────────────────────

export function provenanceComment(runId: string, ext: string): string {
  const tag = `bot:edit run-id=${runId} ts=${new Date().toISOString()}`;
  if (ext === '.php') return `<?php /* ${tag} */ ?>\n`;
  if (ext === '.css' || ext === '.scss') return `/* ${tag} */\n`;
  if (ext === '.html' || ext === '.twig') return `<!-- ${tag} -->\n`;
  if (ext === '.js' || ext === '.ts') return `// ${tag}\n`;
  return `# ${tag}\n`;
}

// ─── Human-recently-modified guard ────────────────────────────────────────────

export async function getRecentHumanModifiedFiles(
  localPath: string,
  daysSince: number = 7,
): Promise<string[]> {
  try {
    const git = simpleGit(localPath);
    const since = new Date(Date.now() - daysSince * 86400_000).toISOString();
    const log = await git.log({ '--since': since, '--name-only': null });
    const files = new Set<string>();
    for (const commit of log.all) {
      const diff = await git.diff(['--name-only', `${commit.hash}^`, commit.hash]);
      diff.split('\n').filter(Boolean).forEach(f => files.add(f));
    }
    return [...files];
  } catch {
    return [];
  }
}

// ─── Shadow-mode helpers ──────────────────────────────────────────────────────

export function isShadowMode(ctx: RunContext): boolean {
  return ctx.shadowMode;
}

export function shadowModeNote(): string {
  return '[shadow-mode] PR created as draft (do-not-merge). Auto-merge disabled until thresholds met.';
}
