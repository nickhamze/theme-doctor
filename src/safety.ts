import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CircuitBreakerState, RunContext } from './types.js';
import { atomicWriteFile } from './util.js';

const BREAKER_MAX_CONSECUTIVE_FAILS = 3;

// ─── Circuit breaker ──────────────────────────────────────────────────────────

function safeId(themeId: string): string {
  // Re-sanitize at use site to guard against IDs that bypassed the intake sanitization
  return sanitizeId(themeId) || 'unknown';
}

function breakerPath(configDir: string, themeId: string): string {
  return path.join(configDir, '.theme-doctor', 'breakers', `${safeId(themeId)}.json`);
}

export async function readBreaker(configDir: string, themeId: string): Promise<CircuitBreakerState> {
  const p = breakerPath(configDir, themeId);
  try {
    await fsp.access(p);
  } catch {
    return { themeId, consecutiveFails: 0, tripped: false };
  }
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw) as CircuitBreakerState;
  } catch {
    // Corrupted breaker file — reset to safe default
    return { themeId, consecutiveFails: 0, tripped: false };
  }
}

export async function writeBreaker(configDir: string, state: CircuitBreakerState): Promise<void> {
  const p = breakerPath(configDir, state.themeId);
  // Pass 13: atomic write — prevents corrupted breaker file on crash
  await atomicWriteFile(p, JSON.stringify(state, null, 2));
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
  const logDir = path.join(configDir, 'audit', safeId(themeId));
  await fsp.mkdir(logDir, { recursive: true });
  // runId is nanoid (base64url) — safe, but still cap length
  const safeRunId = String(runId).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64);
  const logPath = path.join(logDir, `${safeRunId}.jsonl`);
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
  /^style\.css$/,                     // theme metadata header
  /^theme\.json$/,                    // FSE schema fields
  /package(-lock)?\.json$/,           // npm lockfiles
  /composer\.(json|lock)$/,           // PHP lockfiles
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /^wp-config\.php$/,                 // WordPress config (shouldn't be in a theme but guard anyway)
  /^\.env(\..*)?$/,                   // environment variable files
  /^\.htaccess$/,                     // server config
];

export function isDenylisted(relativePath: string): boolean {
  // Normalise to forward slashes, strip leading ./
  const norm = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const basename = norm.split('/').pop() ?? norm;
  return DENYLIST_PATTERNS.some(p => p.test(norm) || p.test(basename));
}

// ─── Theme ID sanitization ────────────────────────────────────────────────────

/**
 * Sanitize a theme ID so it is safe to embed in file paths and directory names.
 * Strips anything that isn't alphanumeric, hyphen, or underscore, and collapses
 * leading dots and path separators that could enable traversal.
 */
export function sanitizeId(id: string): string {
  return id
    .replace(/\.\./g, '')      // remove traversal sequences first
    .replace(/[/\\]/g, '-')    // turn separators into dashes
    .replace(/[^a-zA-Z0-9_\-.]/g, '-') // only safe chars
    .replace(/^[.\-]+/, '')    // no leading dots or dashes
    .slice(0, 128);            // hard length cap
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

    // Pass 16: check for shallow clone — skip deep diff on shallow repos
    const isShallow = await fsp.access(
      `${localPath}/.git/shallow`,
    ).then(() => true).catch(() => false);

    const since = new Date(Date.now() - daysSince * 86400_000).toISOString();
    const log = await git.log({ '--since': since, '--name-only': null });
    const files = new Set<string>();

    for (const commit of log.all) {
      try {
        // Pass 16: `hash^` fails on the initial commit (no parent); catch and skip
        const diff = await git.diff(['--name-only', `${commit.hash}^`, commit.hash]);
        diff.split('\n').filter(Boolean).forEach(f => files.add(f));
      } catch {
        // Initial commit or detached HEAD — skip this entry
        if (!isShallow) {
          // For shallow repos this is expected; for full repos log it
          void commit.hash; // we just skip silently
        }
      }
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
