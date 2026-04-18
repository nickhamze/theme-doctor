import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Rubric } from './types.js';

export async function loadRubric(configDir: string): Promise<Rubric> {
  const tplPath  = path.join(configDir, 'rubric', 'templates.yaml');
  const flowPath = path.join(configDir, 'rubric', 'flows.yaml');

  const tplContent  = fs.existsSync(tplPath)  ? await fsp.readFile(tplPath, 'utf8')  : '[]';
  const flowContent = fs.existsSync(flowPath) ? await fsp.readFile(flowPath, 'utf8') : '[]';

  const templates = parseYaml(tplContent) ?? [];
  const flows     = parseYaml(flowContent) ?? [];

  return { templates, flows };
}
