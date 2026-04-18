import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ResolvedTheme } from '../types.js';
import type { Sandbox, SandboxOptions, SandboxBootResult } from './types.js';

const execFileAsync = promisify(execFile);

export class WpEnvSandbox implements Sandbox {
  readonly name = 'wp-env' as const;

  constructor(
    _theme: ResolvedTheme,
    _matrix: { wp: string; wc: string; php: string },
    private options: SandboxOptions,
  ) {}

  async boot(_theme: ResolvedTheme, _matrix: { wp: string; wc: string; php: string }): Promise<SandboxBootResult> {
    const theme  = _theme;
    const matrix = _matrix;

    // Write .wp-env.json into a temp work dir
    // Pass 7: use cryptographically random suffix to prevent collisions in parallel runs
    const uid = crypto.randomBytes(6).toString('hex');
    const workDir = path.join(
      this.options.workDir ?? '/tmp',
      `wpenv-${theme.id}-${uid}`,
    );
    await fsp.mkdir(workDir, { recursive: true });

    const wpEnvConfig = {
      core: `WordPress/WordPress#${matrix.wp === 'latest' ? 'trunk' : matrix.wp}`,
      phpVersion: matrix.php,
      plugins: ['https://downloads.wordpress.org/plugin/woocommerce.latest-stable.zip'],
      themes: [theme.localPath],
      config: {
        WP_DEBUG: true,
        WP_DEBUG_LOG: true,
        WP_DEBUG_DISPLAY: false,
      },
    };

    const wpEnvPath = path.join(workDir, '.wp-env.json');
    await fsp.writeFile(wpEnvPath, JSON.stringify(wpEnvConfig, null, 2));

    // Check if wp-env is available
    let wpEnvBin = 'wp-env';
    try {
      const { stdout } = await execFileAsync('which', ['wp-env']);
      wpEnvBin = stdout.trim();
    } catch {
      wpEnvBin = path.resolve('node_modules/.bin/wp-env');
    }

    // Start wp-env
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(wpEnvBin, ['start', '--xdebug=false'], {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timeout = setTimeout(() => reject(new Error('wp-env boot timeout (120s)')), 120_000);
      proc.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('WordPress development site started')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) reject(new Error(`wp-env exited with code ${code}`));
      });
    });

    // Activate theme and WC via WP-CLI
    await execFileAsync(wpEnvBin, ['run', 'cli', 'wp', 'theme', 'activate', theme.id], { cwd: workDir });
    await execFileAsync(wpEnvBin, ['run', 'cli', 'wp', 'plugin', 'activate', 'woocommerce'], { cwd: workDir });

    const phpLogPath = path.join(workDir, 'wordpress', 'wp-content', 'debug.log');

    // Pass 7 + 25: idempotent shutdown
    let shutdownCalled = false;
    const shutdown = async () => {
      if (shutdownCalled) return;
      shutdownCalled = true;
      try {
        await execFileAsync(wpEnvBin, ['stop'], { cwd: workDir });
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    return {
      url:  'http://localhost:8888',
      port: 8888,
      shutdown,
      phpLogPath,
    };
  }
}
