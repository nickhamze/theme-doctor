import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Rubric } from './types.js';

// ─── Zod schemas for rubric YAML ─────────────────────────────────────────────

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-]*$/;

const RubricSelectorSchema = z.object({
  selector:    z.string().min(1).max(512),
  required:    z.boolean(),
  description: z.string().max(256).optional(),
});

const RubricTemplateSchema = z.object({
  id:          z.string().regex(SAFE_ID_RE, 'ID must be alphanumeric/hyphen/underscore').max(64),
  name:        z.string().max(128),
  urlPattern:  z.string().max(1024),
  urlParams:   z.record(z.string().max(256)).optional(),
  selectors:   z.array(RubricSelectorSchema).max(50).default([]),
  requiresClassification: z.array(z.string()).optional(),
  skipForTypes: z.array(z.enum(['classic', 'hybrid', 'fse'])).optional(),
});

const RubricStepSchema = z.object({
  action:      z.enum(['navigate', 'click', 'fill', 'select', 'assert', 'wait', 'screenshot']),
  selector:    z.string().max(512).optional(),
  value:       z.string().max(1024).optional(),
  url:         z.string().max(1024).optional(),
  description: z.string().max(256).optional(),
});

const RubricFlowSchema = z.object({
  id:          z.string().regex(SAFE_ID_RE, 'ID must be alphanumeric/hyphen/underscore').max(64),
  name:        z.string().max(128),
  steps:       z.array(RubricStepSchema).min(1).max(100),
  requiresClassification: z.array(z.string()).optional(),
});

async function readYamlFile(filePath: string, fallback: string): Promise<unknown> {
  let content = fallback;
  try {
    await fsp.access(filePath);
    content = await fsp.readFile(filePath, 'utf8');
  } catch { /* file missing — use fallback */ }

  try {
    return parseYaml(content);
  } catch (err: unknown) {
    throw new Error(`Invalid YAML in "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function loadRubric(configDir: string): Promise<Rubric> {
  const tplPath  = path.join(configDir, 'rubric', 'templates.yaml');
  const flowPath = path.join(configDir, 'rubric', 'flows.yaml');

  const rawTemplates = await readYamlFile(tplPath, '[]');
  const rawFlows     = await readYamlFile(flowPath, '[]');

  // Ensure we have arrays before Zod validation
  const tplArray  = Array.isArray(rawTemplates)  ? rawTemplates  : [];
  const flowArray = Array.isArray(rawFlows)       ? rawFlows      : [];

  const templates = z.array(RubricTemplateSchema).parse(tplArray);
  const flows     = z.array(RubricFlowSchema).parse(flowArray);

  return { templates, flows };
}
