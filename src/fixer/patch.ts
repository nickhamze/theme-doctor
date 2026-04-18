import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { TriagePlan, PatchResult } from '../types.js';
import { isDenylisted, provenanceComment } from '../safety.js';
import { appendAuditLog } from '../safety.js';

const MAX_EDITS_PER_FILE      = 3;
const MAX_TOTAL_ITERATIONS    = 5;
const MAX_TOKENS_PER_SESSION  = 40_000;
const MAX_REPLACE_BYTES       = 8_192;  // Pass 10: cap single replacement size
const MAX_TOTAL_PATCH_BYTES   = 32_768; // Pass 10: cap total bytes written per session

// Pass 19: Zod schema for LLM patch response
const PatchResponseSchema = z.object({
  edits: z.array(z.object({
    relativePath: z.string().max(512),
    searchStr:    z.string().max(4096),
    replaceStr:   z.string().max(MAX_REPLACE_BYTES),
    reason:       z.string().max(500),
  })).max(20),
  explanation: z.string().max(2000),
  done:        z.boolean(),
});

type PatchResponse = {
  edits:       Array<{ relativePath: string; searchStr: string; replaceStr: string; reason: string }>;
  explanation: string;
  done:        boolean;
};

function applyEdit(content: string, search: string, replace: string): string {
  if (search === '' && replace !== '') {
    // Append at end
    return content + '\n' + replace;
  }
  if (!content.includes(search)) {
    throw new Error(`Search string not found in file`);
  }
  // Use a function form of replace so that `$` in the replacement string is treated
  // as a literal character rather than a regex back-reference (CVE-class issue).
  const idx = content.indexOf(search);
  return content.slice(0, idx) + replace + content.slice(idx + search.length);
}

export async function runPatchAgent(
  plan: TriagePlan,
  themeDir: string,
  configDir: string,
): Promise<PatchResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for patch agent');

  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 125_000 });

  const filesChanged  = new Set<string>();
  const editCountMap  = new Map<string, number>();
  let   iterations    = 0;
  let   totalTokens   = 0;
  let   totalPatchBytes = 0; // Pass 10: track total bytes written
  const provenanceTag = `bot:edit run-id=${plan.runId} ts=${new Date().toISOString()}`;
  const patchDir      = path.join(configDir, 'reports', plan.runId, plan.themeId);
  await fsp.mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, 'proposed.patch');

  // Read the files to touch
  const fileContents: Record<string, string> = {};
  for (const f of plan.filesToTouch) {
    const full = path.join(themeDir, f.relativePath);
    if (fs.existsSync(full)) {
      fileContents[f.relativePath] = await fsp.readFile(full, 'utf8');
    }
  }

  const systemPrompt = `You are a WooCommerce theme patch agent. You receive a triage plan and current file contents. Produce minimal, surgical edits.

Respond with JSON:
{
  "edits": [{"relativePath": "...", "searchStr": "exact text to find", "replaceStr": "replacement text", "reason": "..."}],
  "explanation": "what you changed and why",
  "done": true|false
}

Rules:
- Each edit must have a non-empty relativePath
- searchStr must be unique enough to identify the exact location
- Only edit files listed in the plan
- Prefer the smallest diff possible
- Do NOT edit style.css header lines (Theme Name, Version, etc.)
- Set done=true when you believe the fix is complete`;

  let userContent = [
    `## Triage plan`,
    `Hypothesis: ${plan.hypothesis}`,
    `Risk class: ${plan.riskClass}`,
    `Files to touch: ${plan.filesToTouch.map(f => `${f.relativePath} (${f.reason})`).join(', ')}`,
    ``,
    `## Current file contents:`,
    Object.entries(fileContents).map(([f, c]) =>
      `### ${f}\n\`\`\`\n${c}\n\`\`\``
    ).join('\n\n'),
  ].join('\n');

  while (iterations < MAX_TOTAL_ITERATIONS && totalTokens < MAX_TOKENS_PER_SESSION) {
    iterations++;

    const msg = await Promise.race([
      client.messages.create({
        model:      'claude-sonnet-4-5',
        max_tokens: 2048,
        temperature: 0.1,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userContent }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Patch LLM timeout (120s)')), 120_000),
      ),
    ]);

    totalTokens += (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0);

    await appendAuditLog(configDir, plan.themeId, plan.runId, {
      phase:      'patch',
      iteration:  iterations,
      tokensDelta: msg.usage,
    });

    const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let response: PatchResponse = { edits: [], explanation: '', done: true };

    try {
      const raw = JSON.parse(jsonMatch?.[0] ?? '{}');
      // Pass 19: validate with Zod; fall back to safe empty response on failure
      const validated = PatchResponseSchema.safeParse(raw);
      response = validated.success ? validated.data : { edits: [], explanation: 'Schema validation failed', done: true };
    } catch {
      break;
    }

    // Pass 10: abort if total patch size already exceeded
    if (totalPatchBytes >= MAX_TOTAL_PATCH_BYTES) {
      break;
    }

    // Apply edits
    const appliedEdits: string[] = [];
    for (const edit of (response.edits ?? [])) {
      if (!edit.relativePath) continue;

      // Denylist check
      if (isDenylisted(edit.relativePath)) {
        appliedEdits.push(`BLOCKED (denylist): ${edit.relativePath}`);
        continue;
      }

      // Anti-thrash: max edits per file
      const current = editCountMap.get(edit.relativePath) ?? 0;
      if (current >= MAX_EDITS_PER_FILE) {
        appliedEdits.push(`BLOCKED (max edits): ${edit.relativePath}`);
        continue;
      }

      // Path must be strictly within themeDir (add sep to prevent /foo/bar-evil matching /foo/bar)
      const resolvedTheme = path.resolve(themeDir);
      const full = path.resolve(themeDir, edit.relativePath);
      if (!full.startsWith(resolvedTheme + path.sep) && full !== resolvedTheme) {
        appliedEdits.push(`BLOCKED (path escape): ${edit.relativePath}`);
        continue;
      }

      // Validate that relativePath from triage plan matches plan's filesToTouch list
      const isInPlan = plan.filesToTouch.some(
        f => path.resolve(themeDir, f.relativePath) === full,
      );
      if (!isInPlan) {
        appliedEdits.push(`BLOCKED (not in plan): ${edit.relativePath}`);
        continue;
      }

      if (!fs.existsSync(full)) {
        appliedEdits.push(`SKIPPED (not found): ${edit.relativePath}`);
        continue;
      }

      // Pass 10: enforce per-replacement byte cap
      if (Buffer.byteLength(edit.replaceStr, 'utf8') > MAX_REPLACE_BYTES) {
        appliedEdits.push(`BLOCKED (replace too large): ${edit.relativePath}`);
        continue;
      }

      try {
        const ext = path.extname(full);
        const prov = provenanceComment(plan.runId, ext);
        let content = await fsp.readFile(full, 'utf8');

        // Add provenance marker if not already present
        if (!content.includes(`bot:edit run-id=${plan.runId}`)) {
          content = prov + content;
        }

        content = applyEdit(content, edit.searchStr, edit.replaceStr);

        // Pass 10: enforce total patch byte cap
        const editDelta = Buffer.byteLength(edit.replaceStr, 'utf8') - Buffer.byteLength(edit.searchStr, 'utf8');
        if (totalPatchBytes + Math.max(0, editDelta) > MAX_TOTAL_PATCH_BYTES) {
          appliedEdits.push(`BLOCKED (total patch size exceeded): ${edit.relativePath}`);
          continue;
        }
        totalPatchBytes += Math.max(0, editDelta);

        await fsp.writeFile(full, content, 'utf8');

        fileContents[edit.relativePath] = content;
        filesChanged.add(edit.relativePath);
        editCountMap.set(edit.relativePath, current + 1);
        appliedEdits.push(`APPLIED: ${edit.relativePath} — ${edit.reason}`);
      } catch (err: unknown) {
        const msg2 = err instanceof Error ? err.message : String(err);
        appliedEdits.push(`ERROR: ${edit.relativePath} — ${msg2}`);
      }
    }

    // Update conversation for next iteration
    userContent = [
      `Applied edits:\n${appliedEdits.join('\n')}`,
      ``,
      `Updated file contents:`,
      Object.entries(fileContents).map(([f, c]) =>
        `### ${f}\n\`\`\`\n${c}\n\`\`\``
      ).join('\n\n'),
    ].join('\n');

    if (response.done) break;
  }

  // Write proposed patch
  const patchLines = [`# Theme Doctor patch — run ${plan.runId}`, `# Theme: ${plan.themeId}`, ''];
  for (const f of filesChanged) {
    patchLines.push(`## ${f}`);
  }
  await fsp.writeFile(patchPath, patchLines.join('\n'));

  return {
    success:       filesChanged.size > 0,
    filesChanged:  [...filesChanged],
    patchPath,
    iterations,
    tokenCount:    totalTokens,
    provenanceTag,
  };
}
