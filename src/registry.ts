import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import simpleGit from 'simple-git';
import got from 'got';
import AdmZip from 'adm-zip';
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

async function ensureGitSource(
  url: string,
  ref: string,
  destDir: string,
): Promise<string> {
  const git = simpleGit();
  if (fs.existsSync(path.join(destDir, '.git'))) {
    const repo = simpleGit(destDir);
    await repo.fetch('origin');
    await repo.checkout(ref);
    await repo.pull('origin', ref);
  } else {
    await fsp.mkdir(destDir, { recursive: true });
    await git.clone(url, destDir, ['--branch', ref, '--depth', '1']);
  }
  return destDir;
}

// ─── Zip download / extract ───────────────────────────────────────────────────

async function ensureZipSource(url: string, destDir: string): Promise<string> {
  await fsp.mkdir(destDir, { recursive: true });
  const zipPath = path.join(destDir, '_download.zip');
  const response = await got(url, { responseType: 'buffer' });
  await fsp.writeFile(zipPath, response.body);
  const zip = new AdmZip(zipPath);
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

  if (src.type === 'path') {
    const resolved = path.isAbsolute(src.path)
      ? src.path
      : path.resolve(configDir, src.path);
    // Resolve symlinks
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    return [{ ...base, id: entry.id, localPath: real }];
  }

  if (src.type === 'git') {
    const ref = src.ref ?? 'main';
    const dest = path.join(cacheDir, 'sources', entry.id);
    const localPath = await ensureGitSource(src.url, ref, dest);
    return [{ ...base, id: entry.id, localPath }];
  }

  if (src.type === 'zip') {
    const dest = path.join(cacheDir, 'sources', entry.id);
    const localPath = await ensureZipSource(src.url, dest);
    return [{ ...base, id: entry.id, localPath }];
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
      const id = path.basename(real);
      themes.push({ ...base, id, localPath: real });
    }
    return themes;
  }

  return [];
}

// ─── Resolve all themes ───────────────────────────────────────────────────────

export async function resolveAllThemes(
  config: ThemeDoctorConfig,
  configDir: string,
  cacheDir: string,
): Promise<ResolvedTheme[]> {
  const all: ResolvedTheme[] = [];
  for (const entry of config.themes) {
    const resolved = await resolveThemeEntry(entry, config, configDir, cacheDir);
    for (const t of resolved) {
      if (all.some(x => x.id === t.id)) {
        console.warn(`[registry] Duplicate theme id "${t.id}" — skipping second occurrence.`);
        continue;
      }
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
