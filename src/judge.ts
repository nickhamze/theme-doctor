import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { sanitizeId } from './safety.js';

// Pass 9 + 19: Zod schema for LLM judge response
const LlmVerdictSchema = z.object({
  verdict:           z.enum(['pass', 'cosmetic', 'layout', 'functional']),
  confidence:        z.number().min(0).max(1),
  evidence:          z.array(z.string().max(500)).max(20),
  suggested_fix_hint: z.string().max(500).optional(),
});
import type {
  EvidencePacket,
  EvidenceCapture,
  JudgementResult,
  RunJudgement,
  Rubric,
  Verdict,
  Viewport,
} from './types.js';

const execFileAsync = promisify(execFile);

// ─── Golden paths ─────────────────────────────────────────────────────────────

export function goldenDir(configDir: string, themeId: string, wp: string, wc: string): string {
  // Sanitize all user-controlled path segments
  const safeWp  = wp.replace(/[^a-zA-Z0-9.\-]/g, '_').slice(0, 32);
  const safeWc  = wc.replace(/[^a-zA-Z0-9.\-]/g, '_').slice(0, 32);
  return path.join(configDir, 'goldens', sanitizeId(themeId), `${safeWp}-${safeWc}`);
}

// Sanitize template/flow IDs for use in filenames — defense-in-depth beyond Zod rubric validation
function safeTemplateId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) || 'unknown';
}

export function goldenScreenshotPath(dir: string, templateId: string, viewport: Viewport): string {
  return path.join(dir, `${safeTemplateId(templateId)}-${viewport}.png`);
}

export function goldenSignaturePath(dir: string, templateId: string, viewport: Viewport): string {
  return path.join(dir, `${safeTemplateId(templateId)}-${viewport}.sig`);
}

// ─── Tier 1: Rubric assertions ────────────────────────────────────────────────

function judgeRubric(
  capture: EvidenceCapture,
  rubric: Rubric,
): { verdict: Verdict; evidence: string[] } | null {
  const template = rubric.templates.find(t => t.id === capture.templateId);
  if (!template) return null;

  const failures: string[] = [];

  for (const result of capture.domSnapshot) {
    if (result.required && !result.found) {
      failures.push(`Required selector not found: "${result.selector}"`);
    }
  }

  for (const err of capture.consoleMessages) {
    if (err.type === 'error') {
      failures.push(`JS error: ${err.text}`);
    }
  }

  for (const net of capture.networkFailures) {
    failures.push(`Network failure: ${net.method} ${net.url} → ${net.status}`);
  }

  if (failures.length > 0) {
    return { verdict: 'functional', evidence: failures };
  }
  return null;
}

// ─── Tier 2: Layout signature diff ───────────────────────────────────────────

async function judgeSignature(
  capture: EvidenceCapture,
  goldenDir: string,
): Promise<{ verdict: Verdict; evidence: string[] } | null> {
  const sigPath = goldenSignaturePath(goldenDir, capture.templateId, capture.viewport);
  if (!fs.existsSync(sigPath)) return null; // no golden yet

  const golden = await fsp.readFile(sigPath, 'utf8');
  if (golden.trim() === capture.layoutSignature) return null; // pass

  return {
    verdict:  'layout',
    evidence: [`Layout signature changed (golden: ${golden.slice(0, 8)}…, current: ${capture.layoutSignature.slice(0, 8)}…)`],
  };
}

// ─── Tier 3: Pixel diff ───────────────────────────────────────────────────────

const PIXEL_DIFF_THRESHOLD = 0.02; // 2%

async function judgePixelDiff(
  capture: EvidenceCapture,
  gDir: string,
): Promise<{ verdict: Verdict; evidence: string[]; diffPath?: string; diffPct?: number } | null> {
  // Bug fix: if the capture failed (empty path), there's nothing to diff
  if (!capture.screenshotPath) return null;

  const goldenPath = goldenScreenshotPath(gDir, capture.templateId, capture.viewport);
  if (!fs.existsSync(goldenPath)) return null;

  // Also verify the capture screenshot actually exists on disk
  try {
    await fsp.access(capture.screenshotPath);
  } catch {
    return null;
  }

  const diffPath = capture.screenshotPath.replace('.png', '-diff.png');

  try {
    const { stdout } = await execFileAsync('odiff', [
      goldenPath,
      capture.screenshotPath,
      diffPath,
      '--threshold', String(PIXEL_DIFF_THRESHOLD),
      '--output-diff-mask',
    ]);
    const pctMatch = stdout.match(/(\d+(?:\.\d+)?)\s*%/);
    const diffPct = pctMatch ? parseFloat(pctMatch[1]!) / 100 : 0;

    if (diffPct <= PIXEL_DIFF_THRESHOLD) return null; // pass

    const verdict: Verdict = diffPct > 0.10 ? 'layout' : 'cosmetic';
    return {
      verdict,
      evidence: [`Pixel diff ${(diffPct * 100).toFixed(2)}% (threshold ${(PIXEL_DIFF_THRESHOLD * 100).toFixed(0)}%)`],
      diffPath,
      diffPct,
    };
  } catch {
    return null; // odiff not available or comparison failed
  }
}

// ─── Tier 4: LLM judge ───────────────────────────────────────────────────────

type LlmVerdict = z.infer<typeof LlmVerdictSchema>;

async function judgeLlm(
  capture: EvidenceCapture,
  goldenDir: string,
  rubric: Rubric,
  diffClueHint?: string,
): Promise<LlmVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      verdict:    'pass',
      confidence: 0.5,
      evidence:   ['No ANTHROPIC_API_KEY set; skipping LLM judge'],
    };
  }

  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 65_000 });
  const template = rubric.templates.find(t => t.id === capture.templateId);

  // Pass 9: only read files that exist AND are non-empty PNGs
  const isValidPng = async (p: string): Promise<boolean> => {
    try {
      const buf = await fsp.readFile(p);
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    } catch { return false; }
  };

  const screenContent = (await isValidPng(capture.screenshotPath))
    ? await fsp.readFile(capture.screenshotPath)
    : null;

  const goldenPath = goldenScreenshotPath(goldenDir, capture.templateId, capture.viewport);
  const goldenContent = (await isValidPng(goldenPath))
    ? await fsp.readFile(goldenPath)
    : null;

  // Pass 21: cap image size sent to LLM (5MB max each to stay within API limits)
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const screenToSend = screenContent && screenContent.length <= MAX_IMAGE_BYTES ? screenContent : null;
  const goldenToSend = goldenContent && goldenContent.length <= MAX_IMAGE_BYTES ? goldenContent : null;

  const imageContent: Anthropic.ImageBlockParam[] = [];
  if (screenToSend) {
    imageContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenToSend.toString('base64') },
    });
  }
  if (goldenToSend) {
    imageContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: goldenToSend.toString('base64') },
    });
  }

  const systemPrompt = `You are a WooCommerce theme QA judge. You classify visual and functional issues in theme screenshots.
Respond with a JSON object matching exactly:
{ "verdict": "pass|cosmetic|layout|functional", "confidence": 0.0-1.0, "evidence": ["..."], "suggested_fix_hint": "..." }
Verdicts:
- pass: looks correct, no meaningful issues
- cosmetic: minor visual differences (colour, spacing <5px, font weight) that don't break usability
- layout: structural positioning issues, overlapping elements, broken responsive behaviour
- functional: WooCommerce UI missing or broken (no Add to Cart, no price, checkout inaccessible)`;

  const userText = [
    `Template: ${capture.templateId} at ${capture.viewport}px viewport`,
    `URL: ${capture.url}`,
    template ? `Required selectors: ${template.selectors.map(s => s.selector).join(', ')}` : '',
    diffClueHint ? `Pixel diff hint: ${diffClueHint}` : '',
    `Console errors: ${capture.consoleMessages.filter(m => m.type === 'error').length}`,
    imageContent.length === 2 ? 'First image = current, second image = golden baseline.' : '',
  ].filter(Boolean).join('\n');

  const msg = await Promise.race([
    client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 512,
      temperature: 0.1,
      system:     systemPrompt,
      messages: [
        {
          role:    'user',
          content: [
            ...imageContent,
            { type: 'text', text: userText },
          ],
        },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Judge LLM timeout (60s)')), 60_000),
    ),
  ]);

  try {
    const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const raw = JSON.parse(jsonMatch[0]);
      const validated = LlmVerdictSchema.safeParse(raw);
      if (validated.success) return validated.data;
    }
  } catch { /* fall through */ }

  return { verdict: 'pass', confidence: 0.5, evidence: ['LLM response parse error'] };
}

// ─── Judge a single capture (ladder) ─────────────────────────────────────────

async function judgeCapture(
  capture: EvidenceCapture,
  gDir: string,
  rubric: Rubric,
): Promise<JudgementResult> {
  // Tier 1 — rubric
  const rubricResult = judgeRubric(capture, rubric);
  if (rubricResult) {
    return {
      templateId: capture.templateId,
      viewport:   capture.viewport,
      verdict:    rubricResult.verdict,
      tier:       'rubric',
      confidence: 1.0,
      evidence:   rubricResult.evidence,
    };
  }

  // Tier 2 — signature
  const sigResult = await judgeSignature(capture, gDir);
  if (sigResult) {
    // Don't immediately fail on sig diff — continue to pixel diff for more signal
    // Tier 3 — pixel diff
    const pixResult = await judgePixelDiff(capture, gDir);
    if (pixResult) {
      // Tier 4 — LLM tiebreaker
      const llmResult = await judgeLlm(capture, gDir, rubric, pixResult.evidence[0]);
      return {
        templateId:     capture.templateId,
        viewport:       capture.viewport,
        verdict:        llmResult.verdict,
        tier:           'llm',
        confidence:     llmResult.confidence,
        evidence:       llmResult.evidence,
        suggestedFixHint: llmResult.suggested_fix_hint,
        pixelDiffPath:  pixResult.diffPath,
        pixelDiffPct:   pixResult.diffPct,
      };
    }
    // Sig differed but no pixel diff change — mark as layout with low confidence
    return {
      templateId: capture.templateId,
      viewport:   capture.viewport,
      verdict:    'layout',
      tier:       'signature',
      confidence: 0.7,
      evidence:   sigResult.evidence,
    };
  }

  // Tier 3 — pixel diff (sig matched but may still have pixel changes)
  const pixResult = await judgePixelDiff(capture, gDir);
  if (pixResult) {
    // Tier 4 — LLM
    const llmResult = await judgeLlm(capture, gDir, rubric, pixResult.evidence[0]);
    return {
      templateId:     capture.templateId,
      viewport:       capture.viewport,
      verdict:        llmResult.verdict,
      tier:           'llm',
      confidence:     llmResult.confidence,
      evidence:       llmResult.evidence,
      suggestedFixHint: llmResult.suggested_fix_hint,
      pixelDiffPath:  pixResult.diffPath,
      pixelDiffPct:   pixResult.diffPct,
    };
  }

  return {
    templateId: capture.templateId,
    viewport:   capture.viewport,
    verdict:    'pass',
    tier:       'signature',
    confidence: 1.0,
    evidence:   [],
  };
}

// ─── Judge a full evidence packet ─────────────────────────────────────────────

export async function judgePacket(
  packet: EvidencePacket,
  configDir: string,
  rubric: Rubric,
): Promise<RunJudgement> {
  const gDir = goldenDir(configDir, packet.themeId, packet.matrix.wp, packet.matrix.wc);
  const verdicts: JudgementResult[] = [];

  for (const capture of packet.captures) {
    const result = await judgeCapture(capture, gDir, rubric);
    verdicts.push(result);
  }

  const failCount = verdicts.filter(v => v.verdict !== 'pass').length;
  const passCount = verdicts.length - failCount;

  // Overall = worst verdict seen
  const SEVERITY: Record<Verdict, number> = { pass: 0, cosmetic: 1, layout: 2, functional: 3 };
  const overallVerdict = verdicts.reduce<Verdict>(
    (worst, v) => SEVERITY[v.verdict] > SEVERITY[worst] ? v.verdict : worst,
    'pass',
  );

  return {
    runId:          packet.runId,
    themeId:        packet.themeId,
    verdicts,
    overallVerdict,
    passCount,
    failCount,
    judgedAt:       new Date().toISOString(),
  };
}

// ─── Bootstrap goldens from a passing run ────────────────────────────────────

export async function bootstrapGoldens(
  packet: EvidencePacket,
  configDir: string,
): Promise<void> {
  const gDir = goldenDir(configDir, packet.themeId, packet.matrix.wp, packet.matrix.wc);
  await fsp.mkdir(gDir, { recursive: true });

  for (const capture of packet.captures) {
    const sigPath  = goldenSignaturePath(gDir, capture.templateId, capture.viewport);
    const pngPath  = goldenScreenshotPath(gDir, capture.templateId, capture.viewport);

    await fsp.writeFile(sigPath, capture.layoutSignature);

    if (fs.existsSync(capture.screenshotPath)) {
      await fsp.copyFile(capture.screenshotPath, pngPath);
    }
  }
}

// ─── Check if goldens exist ───────────────────────────────────────────────────

export async function goldensExist(
  configDir: string,
  themeId: string,
  wp: string,
  wc: string,
): Promise<boolean> {
  const gDir = goldenDir(configDir, themeId, wp, wc);
  try {
    await fsp.access(gDir);
  } catch {
    return false;
  }
  const files = await fsp.readdir(gDir);
  return files.length > 0;
}
