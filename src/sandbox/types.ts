import type { ResolvedTheme } from '../types.js';

export interface SandboxOptions {
  configDir:    string;
  blueprintPath: string;
  overlays?:    string[];
  workDir?:     string;
}

export interface SandboxBootResult {
  url:      string;
  port:     number;
  shutdown: () => Promise<void>;
  phpLogPath?: string;
}

export interface Sandbox {
  readonly name: 'playground' | 'wp-env';
  boot(theme: ResolvedTheme, matrix: { wp: string; wc: string; php: string }): Promise<SandboxBootResult>;
}
