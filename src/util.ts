import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function nanoid(length = 12): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Pass 6: Secret redaction ─────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PHP define() with key-like names
  [/define\s*\(\s*['"][\w]*(?:KEY|SECRET|PASSWORD|PASS|TOKEN|AUTH|SALT|NONCE)[\w]*['"]\s*,\s*['"][^'"]{4,}['"]\s*\)/gi, 'define(\'**REDACTED**\', \'**REDACTED**\')'],
  // DB_PASSWORD / DB_USER / DB_NAME
  [/define\s*\(\s*['"]DB_(?:PASSWORD|USER|NAME|HOST)['"]\s*,\s*['"][^'"]*['"]\s*\)/gi, 'define(\'**REDACTED**\', \'**REDACTED**\')'],
  // Bearer tokens
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer **REDACTED**'],
  // HTTP Basic auth in URLs
  [/https?:\/\/[^:@\s]+:[^@\s]+@/g, 'https://**REDACTED**:**REDACTED**@'],
  // Slack webhook URLs
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_\-]+/g, 'https://hooks.slack.com/services/**REDACTED**'],
  // Anthropic API keys
  [/sk-ant-[A-Za-z0-9\-_]{20,}/g, 'sk-ant-**REDACTED**'],
  // Generic "key": "value" patterns with password-like names
  [/["'](?:api_key|apikey|secret|password|passwd|auth_token|access_token)["']\s*[:=]\s*["'][^"']{4,}["']/gi, '"**KEY**": "**REDACTED**"'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ─── Pass 13: Atomic file writes ──────────────────────────────────────────────

/**
 * Write `data` to `dest` atomically by writing to a temp file first and
 * then renaming. Prevents torn writes if the process is killed mid-write.
 */
export async function atomicWriteFile(dest: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(os.tmpdir(), `td-${nanoid()}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// ─── Pass 17: HTML escaping ───────────────────────────────────────────────────

const HTML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
};

export function escHtml(str: string): string {
  return String(str).replace(/[&<>"'/]/g, ch => HTML_ESC[ch] ?? ch);
}

// ─── Pass 22: Debug-mode stack traces ────────────────────────────────────────

let _debugMode = false;

export function setDebugMode(on: boolean): void { _debugMode = on; }
export function isDebugMode(): boolean           { return _debugMode; }

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return _debugMode ? `${err.message}\n${err.stack ?? ''}` : err.message;
  }
  return String(err);
}
