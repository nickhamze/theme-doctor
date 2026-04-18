import simpleGit from 'simple-git';
import type { RunContext, Rubric } from '../types.js';
import type { SandboxBootResult } from '../sandbox/types.js';
import { crawlTheme } from '../crawler.js';
import { judgePacket } from '../judge.js';

/**
 * Binary-search between commitA (last green) and commitB (first failing)
 * to locate the specific bad commit. Returns the hash of the first bad commit.
 */
export async function bisectBadCommit(
  themeDir: string,
  goodCommit: string,
  badCommit: string,
  ctx: RunContext,
  sandbox: SandboxBootResult,
  rubric: Rubric,
): Promise<string | null> {
  const git = simpleGit(themeDir);

  // Collect commits between good and bad
  const log = await git.log({ from: goodCommit, to: badCommit });
  const commits = log.all.map(c => c.hash);

  if (commits.length <= 1) return badCommit;

  let lo = 0;
  let hi = commits.length - 1;
  let firstBad: string | null = badCommit;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const hash = commits[mid]!;

    // Checkout midpoint
    await git.checkout(hash);

    // Run a quick crawl + judge
    const packet   = await crawlTheme(ctx, sandbox, rubric, ctx.theme.viewports);
    const judgement = await judgePacket(packet, ctx.configDir, rubric);

    if (judgement.overallVerdict === 'pass') {
      lo = mid + 1; // bug was introduced after mid
    } else {
      firstBad = hash;
      hi = mid;     // bug may have been introduced at or before mid
    }
  }

  // Restore to HEAD
  await git.checkout('HEAD');

  return firstBad;
}
