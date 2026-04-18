import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ThemeDoctorConfig, ThemeEntry, Defaults } from './types.js';

// ─── Pass 12: Stricter Zod schemas ────────────────────────────────────────────

// Safe version string: only digits, dots, and the literal "latest"
const VersionStringSchema = z.string().trim().regex(/^(?:latest|[0-9]+(?:\.[0-9]+)*)$/, 'Must be "latest" or a version like "6.7"');

const SourcePathSchema = z.object({ type: z.literal('path'), path: z.string().min(1).max(4096) });
const SourceGitSchema  = z.object({ type: z.literal('git'),  url: z.string().url().max(2048), ref: z.string().max(256).optional() });
const SourceZipSchema  = z.object({ type: z.literal('zip'),  url: z.string().url().max(2048) });
const SourceGlobSchema = z.object({ type: z.literal('glob'), pattern: z.string().min(1).max(4096), detect_woo: z.boolean().optional() });
const SourceSchema = z.discriminatedUnion('type', [SourcePathSchema, SourceGitSchema, SourceZipSchema, SourceGlobSchema]);

const MatrixSchema = z.object({
  wp:  z.array(VersionStringSchema).max(10).optional(),
  wc:  z.array(VersionStringSchema).max(10).optional(),
  php: z.array(VersionStringSchema).max(10).optional(),
});

const DefaultsSchema = z.object({
  branch:    z.string().trim().max(256).optional(),
  viewports: z.array(z.number().int().min(320).max(3840)).max(10).optional(),
  matrix:    MatrixSchema.optional(),
  sandbox:   z.enum(['playground', 'wp-env', 'auto']).optional(),
  pr: z.object({
    create:              z.boolean().optional(),
    auto_merge_cosmetic: z.boolean().optional(),
  }).optional(),
  budget: z.object({
    max_cost_usd_per_run: z.number().positive().max(100).optional(),
  }).optional(),
}).optional();

const ThemeEntrySchema = z.object({
  id:         z.string().trim().min(1).max(128).optional(),
  source:     SourceSchema,
  repo:       z.string().trim().max(512).optional(),
  owner:      z.string().trim().max(256).optional(),
  branch:     z.string().trim().max(256).optional(),
  viewports:  z.array(z.number().int().min(320).max(3840)).max(10).optional(),
  matrix:     MatrixSchema.optional(),
  sandbox:    z.enum(['playground', 'wp-env', 'auto']).optional(),
  detect_woo: z.boolean().optional(),
});

const ConfigSchema = z.object({
  // Pass 12: enforce exact supported version
  version:      z.number().int().min(1).max(1),
  defaults:     DefaultsSchema,
  themes:       z.array(ThemeEntrySchema).min(0).max(200),
  integrations: z.object({
    slack:     z.object({ webhook_url_env: z.string().trim().max(128) }).optional(),
    dashboard: z.object({ publish: z.string().max(512).optional(), repo: z.string().max(512).optional() }).optional(),
  }).optional(),
});

// ─── Load ─────────────────────────────────────────────────────────────────────

export const CONFIG_FILENAME = 'theme-doctor.yaml';

export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(configPath: string): ThemeDoctorConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err: unknown) {
    throw new Error(`Cannot read config file "${configPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    // Pass 12: yaml.parse is safe against circular references in this library
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    throw new Error(`Invalid YAML in "${configPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`"${configPath}" must be a YAML mapping, not a scalar or array`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid theme-doctor.yaml:\n${issues}`);
  }

  const data = result.data;

  // Normalise: ensure every theme entry has an id
  const themes: ThemeEntry[] = data.themes.map((t, idx) => {
    const source = t.source as ThemeEntry['source'];
    let id = t.id;
    if (!id) {
      if (source.type === 'path')        id = path.basename(source.path);
      else if (source.type === 'git')    id = path.basename(source.url, '.git');
      else if (source.type === 'zip')    id = path.basename(new URL(source.url).pathname, '.zip');
      else                               id = `theme-${idx}`;
    }
    return { ...t, id, source } as ThemeEntry;
  });

  return {
    version:      data.version,
    defaults:     data.defaults as Defaults | undefined,
    themes,
    integrations: data.integrations,
  };
}

/** Async version of loadConfig for non-CLI contexts */
export async function loadConfigAsync(configPath: string): Promise<ThemeDoctorConfig> {
  // Verify the file exists and is readable before calling the sync version
  await fsp.access(configPath);
  return loadConfig(configPath);
}

export function resolveConfigDir(configPath: string): string {
  return path.dirname(path.resolve(configPath));
}
