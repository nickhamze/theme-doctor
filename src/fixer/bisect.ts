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

  // Validate commit hashes to prevent git arg injection
  const SHA_RE = /^[0-9a-f]{7,40}$/i;
  if (!SHA_RE.test(goodCommit) || !SHA_RE.test(badCommit)) {
    throw new Error(`bisectBadCommit: invalid commit hash (must be hex SHA)`);
  }

  // Record current HEAD so we can restore it even on failure
  const originalRef = await git.revparse(['HEAD']).catch(() => badCommit);

  // Collect commits between good and bad using range syntax
  const log = await git.log({ from: goodCommit, to: badCommit });
  const commits = log.all.map(c => c.hash);

  if (commits.length <= 1) return badCommit;

  let lo = 0;
  let hi = commits.length - 1;
  let firstBad: string | null = badCommit;

  try {
    while (lo < hi) {
      const mid  = Math.floor((lo + hi) / 2);
      const hash = commits[mid]!;

      await git.checkout(hash);

      const packet    = await crawlTheme(ctx, sandbox, rubric, ctx.theme.viewports);
      const judgement = await judgePacket(packet, ctx.configDir, rubric);

      if (judgement.overallVerdict === 'pass') {
        lo = mid + 1;
      } else {
        firstBad = hash;
        hi = mid;
      }
    }
  } finally {
    // Bug fix: always restore to original ref, even if bisect throws
    await git.checkout(originalRef).catch(() => undefined);
  }

  return firstBad;
}
