import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import simpleGit from 'simple-git';
import got from 'got';
import AdmZip from 'adm-zip';
import pLimit from 'p-limit';
import { sanitizeId } from './safety.js';
import type { ThemeDoctorConfig, ThemeEntry, ResolvedTheme, MatrixConfig } from './types.js';

const DEFAULT_VIEWPORTS = [375, 768, 1440];
const DEFAULT_MATRIX: MatrixConfig = { wp: ['latest'], wc: ['latest'], php: ['8.2'] };
const DEFAULT_BRANCH  = 'main';
const DEFAULT_SANDBOX = 'auto' as const;

// ─── Woo detection ────────────────────────────────────────────────────────────

async function isWooTheme(dir: string): Promise<boolean> {
  const styleCss = path.join(dir, 'style.css');
  if (!fs.existsSync(styleCss)) return false;
  const content = await fsp.readFile(styleCss, 'utf8');
  return /WooCommerce/i.test(content);
}

// ─── Git clone / pull ─────────────────────────────────────────────────────────

const ALLOWED_GIT_SCHEMES = ['https:', 'git:', 'ssh:'];

async function ensureGitSource(
  url: string,
  ref: string,
  destDir: string,
): Promise<string> {
  // Validate URL scheme to prevent cloning from unexpected sources
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Allow SSH shorthand like git@github.com:org/repo.git
    if (!/^[a-zA-Z0-9_\-]+@[a-zA-Z0-9_\-.]+:[a-zA-Z0-9_\-./]+\.git$/.test(url)) {
      throw new Error(`Invalid git URL: ${url}`);
    }
    parsed = { protocol: 'ssh:' } as URL;
  }
  if (!ALLOWED_GIT_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`Git URL scheme "${parsed.protocol}" is not allowed (use https, git, or ssh): ${url}`);
  }

  // Sanitize ref to prevent git arg injection
  const safeRef = ref.replace(/[^a-zA-Z0-9_\-./]/g, '');
  if (!safeRef) throw new Error(`Invalid git ref: ${ref}`);

  const git = simpleGit();
  if (fs.existsSync(path.join(destDir, '.git'))) {
    const repo = simpleGit(destDir);
    await repo.fetch('origin');
    await repo.checkout(safeRef);
    await repo.pull('origin', safeRef);
  } else {
    await fsp.mkdir(destDir, { recursive: true });
    await git.clone(url, destDir, ['--branch', safeRef, '--depth', '1']);
  }
  return destDir;
}

// ─── Zip download / extract ───────────────────────────────────────────────────

async function ensureZipSource(url: string, destDir: string): Promise<string> {
  // Enforce HTTPS to prevent MITM on downloads
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Zip source URL must use HTTPS (got ${parsed.protocol}): ${url}`);
  }

  await fsp.mkdir(destDir, { recursive: true });
  const zipPath = path.join(destDir, '_download.zip');

  const response = await got(url, {
    responseType:   'buffer',
    timeout:        { request: 60_000 },
    followRedirect: true,
    maxRedirects:   3,
    retry: {
      // Pass 14: retry on transient network errors, but never on 4xx
      limit:   3,
      methods: ['GET'],
      statusCodes: [408, 429, 500, 502, 503, 504],
    },
  });
  await fsp.writeFile(zipPath, response.body);

  const zip = new AdmZip(zipPath);
  const resolvedDest = path.resolve(destDir);

  // Zip-slip protection: validate every entry before extraction
  for (const entry of zip.getEntries()) {
    const entryPath = path.resolve(destDir, entry.entryName);
    if (!entryPath.startsWith(resolvedDest + path.sep) && entryPath !== resolvedDest) {
      throw new Error(`Zip slip detected: entry "${entry.entryName}" would escape destination`);
    }
  }

  zip.extractAllTo(destDir, true);
  await fsp.unlink(zipPath);

  // If zip contained a single subfolder, return that
  const entries = await fsp.readdir(destDir);
  if (entries.length === 1) {
    const single = path.join(destDir, entries[0]!);
    const stat = await fsp.stat(single);
    if (stat.isDirectory()) return single;
  }
  return destDir;
}

// ─── Merge matrix ────────────────────────────────────────────────────────────

function mergeMatrix(
  base: Partial<MatrixConfig> | undefined,
  override: Partial<MatrixConfig> | undefined,
): MatrixConfig {
  return {
    wp:  (override?.wp  ?? base?.wp  ?? DEFAULT_MATRIX.wp),
    wc:  (override?.wc  ?? base?.wc  ?? DEFAULT_MATRIX.wc),
    php: (override?.php ?? base?.php ?? DEFAULT_MATRIX.php),
  };
}

// ─── Resolve a single ThemeEntry → ResolvedTheme[] ───────────────────────────

export async function resolveThemeEntry(
  entry: ThemeEntry,
  config: ThemeDoctorConfig,
  configDir: string,
  cacheDir: string,
): Promise<ResolvedTheme[]> {
  const defaults = config.defaults ?? {};
  const matrix   = mergeMatrix(defaults.matrix, entry.matrix);
  const viewports = entry.viewports ?? defaults.viewports ?? DEFAULT_VIEWPORTS;
  const branch    = entry.branch ?? defaults.branch ?? DEFAULT_BRANCH;
  const sandbox   = entry.sandbox ?? defaults.sandbox ?? DEFAULT_SANDBOX;

  const base: Omit<ResolvedTheme, 'localPath' | 'id'> = {
    source: entry.source,
    repo:   entry.repo,
    owner:  entry.owner,
    branch,
    viewports,
    matrix,
    sandbox,
  };

  const src = entry.source;

  // Sanitize the theme ID — must be done after auto-derivation from path/url
  const safeThemeId = sanitizeId(entry.id);
  if (!safeThemeId) throw new Error(`Theme entry has an invalid or empty ID: "${entry.id}"`);

  if (src.type === 'path') {
    const resolved = path.isAbsolute(src.path)
      ? src.path
      : path.resolve(configDir, src.path);
    // Resolve symlinks
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    return [{ ...base, id: safeThemeId, localPath: real }];
  }

  if (src.type === 'git') {
    const ref = src.ref ?? 'main';
    const dest = path.join(cacheDir, 'sources', safeThemeId);
    const localPath = await ensureGitSource(src.url, ref, dest);
    return [{ ...base, id: safeThemeId, localPath }];
  }

  if (src.type === 'zip') {
    const dest = path.join(cacheDir, 'sources', safeThemeId);
    const localPath = await ensureZipSource(src.url, dest);
    return [{ ...base, id: safeThemeId, localPath }];
  }

  if (src.type === 'glob') {
    const pattern = path.isAbsolute(src.pattern)
      ? src.pattern
      : path.resolve(configDir, src.pattern);
    const matches = (await glob(pattern + '/', { mark: true })).map(m => m.replace(/\/$/, ''));
    const themes: ResolvedTheme[] = [];
    for (const match of matches) {
      const real = fs.realpathSync(match);
      if (src.detect_woo && !(await isWooTheme(real))) continue;
      const rawId = path.basename(real);
      const id    = sanitizeId(rawId);
      if (!id) continue;
      themes.push({ ...base, id, localPath: real });
    }
    return themes;
  }

  return [];
}

// ─── Resolve all themes (parallel, up to 8 concurrent git/zip ops) ───────────

export async function resolveAllThemes(
  config: ThemeDoctorConfig,
  configDir: string,
  cacheDir: string,
): Promise<ResolvedTheme[]> {
  const limit = pLimit(8);

  const nested = await Promise.all(
    config.themes.map(entry => limit(() => resolveThemeEntry(entry, config, configDir, cacheDir))),
  );

  const all: ResolvedTheme[] = [];
  const seenIds = new Set<string>();

  for (const resolved of nested) {
    for (const t of resolved) {
      if (seenIds.has(t.id)) {
        console.warn(`[registry] Duplicate theme id "${t.id}" — skipping second occurrence.`);
        continue;
      }
      seenIds.add(t.id);
      all.push(t);
    }
  }
  return all;
}

// ─── Get git HEAD SHA ─────────────────────────────────────────────────────────

export async function getThemeCommitSha(localPath: string): Promise<string> {
  try {
    const git = simpleGit(localPath);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
