import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import type { ResolvedTheme } from '../types.js';
import type { Sandbox, SandboxOptions, SandboxBootResult } from './types.js';

const execFileAsync = promisify(execFile);

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('No address'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export class PlaygroundSandbox implements Sandbox {
  readonly name = 'playground' as const;

  constructor(
    _theme: ResolvedTheme,
    _matrix: { wp: string; wc: string; php: string },
    private options: SandboxOptions,
  ) {}

  async boot(_theme: ResolvedTheme, _matrix: { wp: string; wc: string; php: string }): Promise<SandboxBootResult> {
    const theme  = _theme;
    const matrix = _matrix;
    const port   = await findFreePort();

    // Build the blueprint by merging base + overlays, then injecting theme path
    const blueprint = await this.buildBlueprint(theme);
    // Bug fix: use cryptographically random suffix to prevent collision in parallel boots
    const uid = crypto.randomBytes(6).toString('hex');
    const bpPath = path.join(
      this.options.workDir ?? '/tmp',
      `blueprint-${theme.id}-${uid}.json`,
    );
    await fsp.mkdir(path.dirname(bpPath), { recursive: true });
    await fsp.writeFile(bpPath, JSON.stringify(blueprint, null, 2));

    // Locate @wp-playground/cli (binary may be wp-playground or wp-playground-cli)
    let playgroundBin = 'wp-playground-cli';
    for (const candidate of [
      'wp-playground',
      'wp-playground-cli',
      path.resolve('node_modules/.bin/wp-playground'),
      path.resolve('node_modules/.bin/wp-playground-cli'),
    ]) {
      try {
        if (candidate.startsWith('/')) {
          const { existsSync } = await import('node:fs');
          if (existsSync(candidate)) { playgroundBin = candidate; break; }
        } else {
          await execFileAsync('which', [candidate]);
          playgroundBin = candidate; break;
        }
      } catch { /* try next */ }
    }

    // Note: Playground CLI does not expose a PHP error log to the host filesystem.
    // phpLogPath is set to undefined here; the crawler handles undefined gracefully.
    // For PHP log capture, use the wp-env sandbox (Docker) instead.
    const phpLogPath = undefined;

    const siteUrl = `http://127.0.0.1:${port}`;

    // Pass 7: bind to loopback only — never expose the sandbox on 0.0.0.0
    const proc = spawn(playgroundBin, [
      'server',
      `--port=${port}`,
      '--host=127.0.0.1',
      `--php=${matrix.php}`,
      `--wp=${matrix.wp}`,
      `--blueprint=${bpPath}`,
      '--blueprint-may-read-adjacent-files',
      `--mount=${theme.localPath}:/wordpress/wp-content/themes/${theme.id}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait for port to open (playground writes to stdout after setup)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Playground boot timeout (120s)'));
      }, 120_000);

      const tryPort = () => {
        const conn = createConnection(port, '127.0.0.1');
        conn.once('connect', () => { conn.destroy(); clearTimeout(timeout); resolve(); });
        conn.once('error', () => setTimeout(tryPort, 500));
      };
      setTimeout(tryPort, 2000);

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0 && code !== null) reject(new Error(`Playground exited with code ${code}`));
      });
    });

    // Pass 7 + 25: idempotent shutdown — safe to call multiple times
    let shutdownCalled = false;
    const shutdown = async () => {
      if (shutdownCalled) return;
      shutdownCalled = true;
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      await fsp.unlink(bpPath).catch(() => undefined);
    };

    return {
      url:  siteUrl,
      port,
      shutdown,
      phpLogPath,
    };
  }

  private async buildBlueprint(theme: ResolvedTheme): Promise<Record<string, unknown>> {
    const basePath = this.options.blueprintPath;

    // Bug fix: JSON.parse wrapped in try/catch — corrupted blueprint JSON must not crash boot
    let base: Record<string, unknown> = { steps: [] };
    if (fs.existsSync(basePath)) {
      try {
        base = JSON.parse(await fsp.readFile(basePath, 'utf8')) as Record<string, unknown>;
      } catch (err: unknown) {
        throw new Error(`Invalid blueprint JSON at "${basePath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Apply overlays
    const overlays = this.options.overlays ?? [];
    for (const overlayPath of overlays) {
      if (!fs.existsSync(overlayPath)) continue;
      try {
        const overlay = JSON.parse(await fsp.readFile(overlayPath, 'utf8')) as Record<string, unknown>;
        const baseSteps    = Array.isArray(base.steps) ? (base.steps as unknown[]) : [];
        const overlaySteps = Array.isArray(overlay.steps) ? (overlay.steps as unknown[]) : [];
        base.steps = [...baseSteps, ...overlaySteps];
      } catch (err: unknown) {
        throw new Error(`Invalid overlay JSON at "${overlayPath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Inject theme activation step (theme is mounted via --mount flag)
    // The theme.id has been sanitized by sanitizeId() so it's safe in a PHP string literal
    const steps = Array.isArray(base.steps) ? (base.steps as unknown[]) : [];
    steps.push({
      step: 'runPHP',
      // Use double-quotes in PHP to avoid backslash issues; theme ID only contains [a-zA-Z0-9_\-.]
      code: `<?php require '/wordpress/wp-load.php'; switch_theme("${theme.id}"); echo "Theme ${theme.id} activated."; ?>`,
    });

    base.steps = steps;
    return base;
  }
}
