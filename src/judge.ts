import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
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
  return path.join(configDir, 'goldens', themeId, `${wp}-${wc}`);
}

export function goldenScreenshotPath(dir: string, templateId: string, viewport: Viewport): string {
  return path.join(dir, `${templateId}-${viewport}.png`);
}

export function goldenSignaturePath(dir: string, templateId: string, viewport: Viewport): string {
  return path.join(dir, `${templateId}-${viewport}.sig`);
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
  const goldenPath = goldenScreenshotPath(gDir, capture.templateId, capture.viewport);
  if (!fs.existsSync(goldenPath)) return null;

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

interface LlmVerdict {
  verdict:          Verdict;
  confidence:       number;
  evidence:         string[];
  suggested_fix_hint?: string;
}

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

  const client = new Anthropic({ apiKey });
  const template = rubric.templates.find(t => t.id === capture.templateId);

  const screenContent = fs.existsSync(capture.screenshotPath)
    ? await fsp.readFile(capture.screenshotPath)
    : null;

  const goldenPath = goldenScreenshotPath(goldenDir, capture.templateId, capture.viewport);
  const goldenContent = fs.existsSync(goldenPath)
    ? await fsp.readFile(goldenPath)
    : null;

  const imageContent: Anthropic.ImageBlockParam[] = [];
  if (screenContent) {
    imageContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenContent.toString('base64') },
    });
  }
  if (goldenContent) {
    imageContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: goldenContent.toString('base64') },
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

  const msg = await client.messages.create({
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
  });

  try {
    const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]) as LlmVerdict;
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
  if (!fs.existsSync(gDir)) return false;
  const files = await fsp.readdir(gDir);
  return files.length > 0;
}
