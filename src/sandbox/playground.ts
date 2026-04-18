import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { ResolvedTheme } from '../types.js';
import type { Sandbox, SandboxOptions, SandboxBootResult } from './types.js';

const execFileAsync = promisify(execFile);

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
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
    const bpPath = path.join(
      this.options.workDir ?? '/tmp',
      `blueprint-${theme.id}-${Date.now()}.json`,
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

    const phpLogPath = path.join(
      this.options.workDir ?? '/tmp',
      `php-${theme.id}-${Date.now()}.log`,
    );

    const siteUrl = `http://127.0.0.1:${port}`;

    // Start playground server — mount theme dir directly for fast activation
    const proc = spawn(playgroundBin, [
      'server',
      `--port=${port}`,
      `--php=${matrix.php}`,
      `--wp=${matrix.wp}`,
      `--blueprint=${bpPath}`,
      '--blueprint-may-read-adjacent-files',
      `--mount=${theme.localPath}:/wordpress/wp-content/themes/${theme.id}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait for port to open (playground writes to stdout after setup)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Playground boot timeout (120s)')), 120_000);
      const { createConnection } = require('node:net') as typeof import('net');

      const tryPort = () => {
        const conn = createConnection(port, '127.0.0.1');
        conn.once('connect', () => { conn.destroy(); clearTimeout(timeout); resolve(); });
        conn.once('error', () => setTimeout(tryPort, 500));
      };
      setTimeout(tryPort, 2000);

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) reject(new Error(`Playground exited with code ${code}`));
      });
    });

    const shutdown = async () => {
      proc.kill('SIGTERM');
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
    const base: Record<string, unknown> = fs.existsSync(basePath)
      ? JSON.parse(await fsp.readFile(basePath, 'utf8'))
      : { steps: [] };

    // Apply overlays
    const overlays = this.options.overlays ?? [];
    for (const overlayPath of overlays) {
      if (!fs.existsSync(overlayPath)) continue;
      const overlay = JSON.parse(await fsp.readFile(overlayPath, 'utf8'));
      const baseSteps = (base.steps as unknown[]) ?? [];
      const overlaySteps = (overlay.steps as unknown[]) ?? [];
      base.steps = [...baseSteps, ...overlaySteps];
    }

    // Inject theme activation step (theme is mounted via --mount flag)
    const steps = (base.steps as unknown[]) ?? [];
    steps.push({
      step: 'runPHP',
      code: `<?php require '/wordpress/wp-load.php'; switch_theme('${theme.id}'); echo 'Theme ${theme.id} activated.'; ?>`,
    });

    base.steps = steps;
    return base;
  }
}
