/**
 * Spike B — wp-env (Docker) + Playwright
 *
 * Proves the full-fidelity Docker sandbox path and validates
 * that the evidence packet shape is identical to Spike A.
 *
 * Usage:
 *   THEME_PATH=/path/to/your-woo-theme npx tsx spike/spike-b-wpenv.ts
 *
 * Prerequisites:
 *   - Docker running
 *   - npm install -g @wordpress/env
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

const THEME_PATH = process.env.THEME_PATH ?? path.resolve('../obel');
const THEME_ID   = path.basename(THEME_PATH);
const OUT_DIR    = path.resolve(`./spike-output-wpenv/${THEME_ID}`);
const VIEWPORTS  = [375, 768, 1440];
const FREEZE_CSS  = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';

async function main() {
  console.log(`\n🩺 Theme Doctor — Spike B (wp-env + Playwright)`);
  console.log(`   Theme path: ${THEME_PATH}`);
  console.log(`   Theme ID:   ${THEME_ID}`);
  console.log(`   Output:     ${OUT_DIR}\n`);

  // ── Check prerequisites ───────────────────────────────────────────────────
  let wpEnvBin = 'wp-env';
  try {
    await execFileAsync('which', ['wp-env']);
  } catch {
    wpEnvBin = path.resolve('./node_modules/.bin/wp-env');
    try { await fsp.access(wpEnvBin); } catch {
      console.error('❌ wp-env not found. Install with: npm i -g @wordpress/env');
      process.exit(1);
    }
  }

  try {
    await execFileAsync('docker', ['info']);
    console.log('✅ Docker is running');
  } catch {
    console.error('❌ Docker is not running. Please start Docker Desktop.');
    process.exit(1);
  }

  await fsp.mkdir(OUT_DIR, { recursive: true });

  // ── Write .wp-env.json ────────────────────────────────────────────────────
  const workDir = path.join(os.tmpdir(), `td-spike-b-${Date.now()}`);
  await fsp.mkdir(workDir, { recursive: true });

  const wpEnvConfig = {
    core: null,
    phpVersion: '8.2',
    plugins: ['https://downloads.wordpress.org/plugin/woocommerce.latest-stable.zip'],
    themes: [THEME_PATH],
    config: {
      WP_DEBUG: true,
      WP_DEBUG_LOG: true,
      WP_DEBUG_DISPLAY: false,
    },
  };

  await fsp.writeFile(
    path.join(workDir, '.wp-env.json'),
    JSON.stringify(wpEnvConfig, null, 2),
  );
  console.log(`📄 .wp-env.json written to ${workDir}`);

  // ── Start wp-env ──────────────────────────────────────────────────────────
  console.log('🚀 Starting wp-env (this may take a few minutes the first time)…');

  try {
    await execFileAsync(wpEnvBin, ['start'], {
      cwd:     workDir,
      timeout: 300_000,
    });
    console.log('✅ wp-env started at http://localhost:8888');
  } catch (err) {
    console.error('❌ wp-env failed to start:', (err as Error).message);
    process.exit(1);
  }

  try {
    // ── Activate WC + theme ────────────────────────────────────────────────
    console.log('🔧 Activating WooCommerce and theme…');
    await execFileAsync(wpEnvBin, ['run', 'cli', '--', 'wp', 'plugin', 'activate', 'woocommerce'], { cwd: workDir });
    await execFileAsync(wpEnvBin, ['run', 'cli', '--', 'wp', 'theme', 'activate', THEME_ID], { cwd: workDir });

    // Create WC pages
    await execFileAsync(wpEnvBin, ['run', 'cli', '--', 'wp', 'eval',
      'WC_Install::create_pages(); echo "WC pages created.";'
    ], { cwd: workDir });

    // Create test product
    await execFileAsync(wpEnvBin, ['run', 'cli', '--', 'wp', 'eval', `
$p = new WC_Product_Simple();
$p->set_name('Spike B Test Product');
$p->set_slug('spike-b-product');
$p->set_regular_price('19.99');
$p->set_status('publish');
$p->set_catalog_visibility('visible');
$p->save();
echo 'Product created.';
`], { cwd: workDir });

    // Set permalinks
    await execFileAsync(wpEnvBin, ['run', 'cli', '--', 'wp', 'rewrite', 'structure', '/%postname%/', '--hard'], { cwd: workDir });

    console.log('✅ Setup complete');

    // ── Crawl ──────────────────────────────────────────────────────────────
    const base  = 'http://localhost:8888';
    const pages = [
      { id: 'shop',    url: '/shop/' },
      { id: 'product', url: '/product/spike-b-product/' },
    ];

    const browser = await chromium.launch({ headless: true });
    const results: Array<{ page: string; viewport: number; screenshot: string; signature: string; errors: number }> = [];

    for (const vp of VIEWPORTS) {
      for (const pg of pages) {
        const context = await browser.newContext();
        const page    = await context.newPage();
        await page.setViewportSize({ width: vp, height: 900 });

        const errors: string[] = [];
        page.on('console', msg => {
          if (msg.type() === 'error') errors.push(msg.text());
        });

        console.log(`   Crawling ${pg.id} @ ${vp}px…`);

        try {
          await page.goto(base + pg.url, { waitUntil: 'networkidle', timeout: 30_000 });
          await page.addStyleTag({ content: FREEZE_CSS });
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(400);
          await page.evaluate(() => window.scrollTo(0, 0));

          const screenshotPath = path.join(OUT_DIR, `${pg.id}-${vp}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });

          const sig = await page.evaluate(() => {
            const parts: string[] = [];
            function walk(el: Element): void {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0)
                parts.push(`${el.tagName.toLowerCase()}:${Math.round(r.x/4)*4},${Math.round(r.y/4)*4}`);
              for (const c of Array.from(el.children)) walk(c);
            }
            walk(document.body);
            return parts.join('|');
          });

          const crypto = await import('node:crypto');
          const signature = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);

          console.log(`     ✅ ${pg.id}@${vp} — sig: ${signature} — errors: ${errors.length}`);
          results.push({ page: pg.id, viewport: vp, screenshot: screenshotPath, signature, errors: errors.length });
        } catch (err: unknown) {
          console.error(`     ❌ ${pg.id}@${vp}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          await context.close();
        }
      }
    }

    await browser.close();

    const reportPath = path.join(OUT_DIR, 'spike-b-report.json');
    await fsp.writeFile(reportPath, JSON.stringify({ themeId: THEME_ID, sandbox: 'wp-env', results }, null, 2));

    console.log(`\n📊 Spike B Summary:`);
    console.log(`   Captures:    ${results.length} (${pages.length} pages × ${VIEWPORTS.length} viewports)`);
    console.log(`   Screenshots: ${OUT_DIR}/`);
    console.log(`   Report:      ${reportPath}`);
    console.log(`\n${results.every(r => r.errors === 0) ? '✅ All clean.' : '⚠️  Some pages had errors — see report.'}`);
  } finally {
    // ── Stop wp-env ────────────────────────────────────────────────────────
    console.log('\n🛑 Stopping wp-env…');
    await execFileAsync(wpEnvBin, ['stop'], { cwd: workDir }).catch(() => undefined);
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('Spike B failed:', err);
  process.exit(1);
});
