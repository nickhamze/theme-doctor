import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import simpleGit from 'simple-git';
import { z } from 'zod';
import type { RunJudgement, TriagePlan, RiskClass } from '../types.js';
import { getRecentHumanModifiedFiles } from '../safety.js';
import { appendAuditLog } from '../safety.js';
import { redactSecrets } from '../util.js';

// ─── Pass 19: Zod schema for LLM triage response ─────────────────────────────

const TriageResponseSchema = z.object({
  hypothesis:        z.string().max(2000),
  filesToTouch:      z.array(z.object({
    relativePath:    z.string().max(512),
    reason:          z.string().max(500),
    expectedLines:   z.number().int().optional(),
  })).max(10),
  riskClass:         z.enum(['cosmetic', 'layout', 'functional']),
  estimatedDiffSize: z.enum(['tiny', 'small', 'medium', 'large']),
});

// Resolve the WP template hierarchy for a given template ID
function wpTemplateFiles(templateId: string): string[] {
  const map: Record<string, string[]> = {
    'home':               ['front-page.php', 'home.php', 'index.php'],
    'shop':               ['woocommerce/archive-product.php', 'archive.php', 'index.php'],
    'product':            ['woocommerce/single-product.php', 'single.php', 'singular.php'],
    'cart':               ['woocommerce/cart/cart.php', 'page.php'],
    'checkout':           ['woocommerce/checkout/form-checkout.php', 'page.php'],
    'order-received':     ['woocommerce/checkout/thankyou.php', 'page.php'],
    'my-account':         ['woocommerce/myaccount/my-account.php', 'page.php'],
    'blog':               ['home.php', 'index.php'],
    'single-post':        ['single-post.php', 'single.php', 'singular.php'],
    'search':             ['search.php', 'index.php'],
    '404':                ['404.php', 'index.php'],
  };
  return map[templateId] ?? ['index.php'];
}

async function readThemeFiles(
  themeDir: string,
  relPaths: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of relPaths) {
    const full = path.join(themeDir, rel);
    if (fs.existsSync(full)) {
      out[rel] = await fsp.readFile(full, 'utf8');
    }
  }
  return out;
}

async function getRecentGitLog(themeDir: string, maxCommits = 10): Promise<string> {
  try {
    const git = simpleGit(themeDir);
    const log = await git.log({ maxCount: maxCommits });
    return log.all.map(c => `${c.hash.slice(0, 8)} ${c.date} ${c.message}`).join('\n');
  } catch {
    return '(git log unavailable)';
  }
}

export async function runTriageAgent(
  judgement: RunJudgement,
  themeDir: string,
  configDir: string,
): Promise<TriagePlan> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for triage agent');

  // Pass 14: configure explicit retry for transient API failures
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 95_000 });

  const failingVerdicts = judgement.verdicts.filter(v => v.verdict !== 'pass');
  const affectedTemplates = [...new Set(failingVerdicts.map(v => v.templateId))];

  // Gather context
  const humanModified = await getRecentHumanModifiedFiles(themeDir, 7);
  const gitLog = await getRecentGitLog(themeDir);

  const relevantFiles: string[] = [];
  for (const tpl of affectedTemplates) {
    relevantFiles.push(...wpTemplateFiles(tpl));
  }
  const uniqueFiles = [...new Set(relevantFiles)];
  const themeFiles = await readThemeFiles(themeDir, uniqueFiles);

  const systemPrompt = `You are a WooCommerce theme triage specialist. Given failing QA results and theme source files, produce a structured fix plan.

You MUST respond with a JSON object:
{
  "hypothesis": "string — root cause explanation",
  "filesToTouch": [{"relativePath": "...", "reason": "...", "expectedLines": 5}],
  "riskClass": "cosmetic|layout|functional",
  "estimatedDiffSize": "tiny|small|medium|large"
}

Rules:
- Only reference files that exist in the theme directory
- Prefer the smallest possible change
- Do NOT suggest editing style.css header, theme.json schema fields, or files outside the theme folder
- Be specific about what to change and why`;

  const userContent = [
    `Theme: ${path.basename(themeDir)}`,
    `Failing templates: ${affectedTemplates.join(', ')}`,
    '',
    '## Failing verdicts:',
    failingVerdicts.map(v =>
      `- ${v.templateId} @ ${v.viewport}px: ${v.verdict} (${v.tier}) — ${v.evidence.join('; ')}`
    ).join('\n'),
    '',
    '## Recent git log:',
    gitLog,
    '',
    '## Human-modified files (last 7 days):',
    humanModified.join(', ') || '(none)',
    '',
    '## Relevant theme files:',
    Object.entries(themeFiles).map(([f, c]) => `### ${f}\n\`\`\`php\n${c.slice(0, 3000)}\n\`\`\``).join('\n\n'),
  ].join('\n');

  const msg = await Promise.race([
    client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 1024,
      temperature: 0.1,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Triage LLM timeout (90s)')), 90_000),
    ),
  ]);

  // Pass 15: Redact secrets before writing to audit log
  await appendAuditLog(configDir, judgement.themeId, judgement.runId, {
    phase:  'triage',
    prompt: redactSecrets(userContent.slice(0, 500)),
    tokens: msg.usage,
  });

  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let plan: Omit<TriagePlan, 'runId' | 'themeId' | 'humanModifiedFiles' | 'createdAt'>;

  try {
    // Pass 19: validate with Zod to reject malformed/oversized LLM responses
    const raw = JSON.parse(jsonMatch?.[0] ?? '{}');
    const validated = TriageResponseSchema.safeParse(raw);
    if (validated.success) {
      plan = validated.data;
    } else {
      plan = {
        hypothesis:        'LLM response failed schema validation.',
        filesToTouch:      [],
        riskClass:         'functional' as RiskClass,
        estimatedDiffSize: 'medium' as const,
      };
    }
  } catch {
    plan = {
      hypothesis:        'Unable to determine root cause automatically.',
      filesToTouch:      [],
      riskClass:         'functional' as RiskClass,
      estimatedDiffSize: 'medium' as const,
    };
  }

  return {
    ...plan,
    runId:              judgement.runId,
    themeId:            judgement.themeId,
    humanModifiedFiles: humanModified,
    createdAt:          new Date().toISOString(),
  };
}
