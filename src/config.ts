import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ThemeDoctorConfig, ThemeEntry, Defaults } from './types.js';

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const SourcePathSchema = z.object({ type: z.literal('path'), path: z.string() });
const SourceGitSchema  = z.object({ type: z.literal('git'),  url: z.string(), ref: z.string().optional() });
const SourceZipSchema  = z.object({ type: z.literal('zip'),  url: z.string() });
const SourceGlobSchema = z.object({ type: z.literal('glob'), pattern: z.string(), detect_woo: z.boolean().optional() });
const SourceSchema = z.discriminatedUnion('type', [SourcePathSchema, SourceGitSchema, SourceZipSchema, SourceGlobSchema]);

const MatrixSchema = z.object({
  wp:  z.array(z.string()).optional(),
  wc:  z.array(z.string()).optional(),
  php: z.array(z.string()).optional(),
});

const DefaultsSchema = z.object({
  branch:    z.string().optional(),
  viewports: z.array(z.number()).optional(),
  matrix:    MatrixSchema.optional(),
  sandbox:   z.enum(['playground', 'wp-env', 'auto']).optional(),
  pr: z.object({
    create:              z.boolean().optional(),
    auto_merge_cosmetic: z.boolean().optional(),
  }).optional(),
  budget: z.object({
    max_cost_usd_per_run: z.number().optional(),
  }).optional(),
}).optional();

const ThemeEntrySchema = z.object({
  id:         z.string().optional(),
  source:     SourceSchema,
  repo:       z.string().optional(),
  owner:      z.string().optional(),
  branch:     z.string().optional(),
  viewports:  z.array(z.number()).optional(),
  matrix:     MatrixSchema.optional(),
  sandbox:    z.enum(['playground', 'wp-env', 'auto']).optional(),
  detect_woo: z.boolean().optional(),
});

const ConfigSchema = z.object({
  version:      z.number(),
  defaults:     DefaultsSchema,
  themes:       z.array(ThemeEntrySchema),
  integrations: z.object({
    slack:     z.object({ webhook_url_env: z.string() }).optional(),
    dashboard: z.object({ publish: z.string().optional(), repo: z.string().optional() }).optional(),
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
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parseYaml(raw);

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
      if (source.type === 'path')   id = path.basename(source.path);
      else if (source.type === 'git') id = path.basename(source.url, '.git');
      else if (source.type === 'zip') id = path.basename(new URL(source.url).pathname, '.zip');
      else id = `theme-${idx}`;
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

export function resolveConfigDir(configPath: string): string {
  return path.dirname(path.resolve(configPath));
}
