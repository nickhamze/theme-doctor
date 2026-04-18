import type {
  RunContext,
  Rubric,
  EvidencePacket,
  RunJudgement,
  PatchResult,
} from '../types.js';
import type { SandboxBootResult } from '../sandbox/types.js';
import { crawlTheme } from '../crawler.js';
import { judgePacket } from '../judge.js';

export interface VerifyResult {
  passed:    boolean;
  judgement: RunJudgement;
  packet:    EvidencePacket;
}

export async function runVerifyAgent(
  ctx: RunContext,
  sandbox: SandboxBootResult,
  rubric: Rubric,
  _patchResult: PatchResult,
  originalJudgement: RunJudgement,
): Promise<VerifyResult> {
  // Identify which templates were originally failing
  const failingTemplateIds = new Set(
    originalJudgement.verdicts
      .filter(v => v.verdict !== 'pass')
      .map(v => v.templateId),
  );

  // Build a reduced rubric containing only the affected templates + flows
  const reducedRubric: Rubric = {
    templates: rubric.templates.filter(t => failingTemplateIds.has(t.id)),
    flows:     rubric.flows.filter(f => failingTemplateIds.has(f.id)),
  };

  // Re-crawl only affected items
  const packet = await crawlTheme(ctx, sandbox, reducedRubric, ctx.theme.viewports);
  const judgement = await judgePacket(packet, ctx.configDir, reducedRubric);

  const passed = judgement.verdicts.every(v => v.verdict === 'pass');

  return { passed, judgement, packet };
}
