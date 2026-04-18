export type { Sandbox, SandboxOptions, SandboxBootResult } from './types.js';
export { PlaygroundSandbox } from './playground.js';
export { WpEnvSandbox } from './wpenv.js';

import type { ResolvedTheme } from '../types.js';
import type { Sandbox, SandboxOptions } from './types.js';
import { PlaygroundSandbox } from './playground.js';
import { WpEnvSandbox } from './wpenv.js';

export async function createSandbox(
  theme: ResolvedTheme,
  matrix: { wp: string; wc: string; php: string },
  options: SandboxOptions,
): Promise<Sandbox> {
  const mode = theme.sandbox === 'auto' ? detectSandbox() : theme.sandbox;

  if (mode === 'playground') {
    return new PlaygroundSandbox(theme, matrix, options);
  }
  return new WpEnvSandbox(theme, matrix, options);
}

function detectSandbox(): 'playground' | 'wp-env' {
  // Default to playground for speed; fallback to wp-env if docker is available
  // and playground is unavailable. For now, always prefer playground.
  return 'playground';
}
