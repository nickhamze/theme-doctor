/**
 * Spike A — WordPress Playground + Playwright
 *
 * Proves the cheapest sandbox path:
 *   1. Boot WP+WC via @wp-playground/cli Blueprint
 *   2. Mount a local theme and activate it
 *   3. Crawl Shop and Single Product at 3 viewports
 *   4. Take screenshots, capture console errors, compute layout signature
 *
 * Usage:
 *   THEME_PATH=/path/to/your-woo-theme npx tsx spike/spike-a-playground.ts
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

const THEME_PATH = process.env.THEME_PATH ?? path.resolve('../obel');
const THEME_ID   = path.basename(THEME_PATH);
const OUT_DIR    = path.resolve(`./spike-output/${THEME_ID}`);
const VIEWPORTS  = [375, 768, 1440];
const FREEZE_CLOCK = '2025-01-15T12:00:00.000Z';
const FREEZE_CSS   = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const a = s.address();
      if (!a || typeof a === 'string') return reject(new Error('no addr'));
      const p = a.port;
      s.close(() => resolve(p));
    });
  });
}

async function buildBlueprint(themeDir: string, themeId: string): Promise<string> {
  const bp = {
    $schema: 'https://playground.wordpress.net/blueprint-schema.json',
    landingPage: '/shop/',
    preferredVersions: { php: '8.2', wp: 'latest' },
    phpExtensionBundles: ['kitchen-sink'],
    features: { networking: true },
    steps: [
      { step: 'login', username: 'admin', password: 'password' },
      {
        step: 'installPlugin',
        pluginData: { resource: 'wordpress.org/plugins', slug: 'woocommerce' },
      },
      { step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/woocommerce' },
      {
        step: 'runPHP',
        code: `<?php
require '/wordpress/wp-load.php';
update_option('woocommerce_store_address', '123 Main St');
update_option('woocommerce_store_city', 'Springfield');
update_option('woocommerce_default_country', 'US:IL');
update_option('woocommerce_store_postcode', '62701');
update_option('woocommerce_currency', 'USD');
update_option('woocommerce_allow_tracking', 'no');
WC_Install::create_pages();
echo 'WC configured.';
?>`,
      },
      {
        step: 'runPHP',
        code: `<?php
require '/wordpress/wp-load.php';
$p = new WC_Product_Simple();
$p->set_name('Spike Test Product');
$p->set_slug('spike-test-product');
$p->set_regular_price('19.99');
$p->set_status('publish');
$p->set_catalog_visibility('visible');
$p->set_manage_stock(true);
$p->set_stock_quantity(99);
$p->set_stock_status('instock');
$id = $p->save();
// Set up permalink
global $wp_rewrite;
$wp_rewrite->set_permalink_structure('/%postname%/');
$wp_rewrite->flush_rules(true);
echo "Product: $id";
?>`,
      },
      // Theme is mounted via --mount flag; just activate it
      {
        step: 'runPHP',
        code: `<?php require '/wordpress/wp-load.php'; switch_theme('${themeId}'); echo 'Theme ${themeId} activated.'; ?>`,
      },
    ],
  };

  const bpPath = `/tmp/td-spike-blueprint-${Date.now()}.json`;
  await fsp.writeFile(bpPath, JSON.stringify(bp, null, 2));
  return bpPath;
}

async function waitForPort(port: number, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const c = net.createConnection(port, '127.0.0.1');
        c.once('connect', () => { c.destroy(); resolve(); });
        c.once('error', (e) => { c.destroy(); reject(e); });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Port ${port} did not open within ${timeout}ms`);
}

async function main() {
  console.log(`\n🩺 Theme Doctor — Spike A (Playground + Playwright)`);
  console.log(`   Theme path: ${THEME_PATH}`);
  console.log(`   Theme ID:   ${THEME_ID}`);
  console.log(`   Output:     ${OUT_DIR}\n`);

  await fsp.mkdir(OUT_DIR, { recursive: true });

  // ── Check wp-playground is available ──────────────────────────────────────
  // Binary may be 'wp-playground' (global) or 'wp-playground-cli' (local/new)
  let playgroundBin: string | null = null;
  for (const candidate of [
    'wp-playground',
    'wp-playground-cli',
    path.resolve('./node_modules/.bin/wp-playground'),
    path.resolve('./node_modules/.bin/wp-playground-cli'),
  ]) {
    try {
      const check = candidate.startsWith('/') ? fsp.access(candidate) : execFileAsync('which', [candidate]);
      await check;
      playgroundBin = candidate;
      console.log(`✅ Playground CLI: ${playgroundBin}`);
      break;
    } catch { /* try next */ }
  }

  if (!playgroundBin) {
    console.error('❌ wp-playground CLI not found. Install with: npm i @wp-playground/cli');
    console.log('\n⚠️  Skipping Playground boot — running Playwright in demo mode against example.com instead.\n');
    await runPlaywrightDemoMode();
    return;
  }

  // ── Build blueprint ────────────────────────────────────────────────────────
  console.log('📋 Building blueprint…');
  const bpPath = await buildBlueprint(THEME_PATH, THEME_ID);
  console.log(`   Blueprint: ${bpPath}`);

  // ── Boot Playground ────────────────────────────────────────────────────────
  const port = await findFreePort();
  const siteUrl = `http://127.0.0.1:${port}`;
  console.log(`🚀 Booting Playground on ${siteUrl}…`);

  const proc = spawn(playgroundBin, [
    'server',
    `--port=${port}`,
    `--blueprint=${bpPath}`,
    '--blueprint-may-read-adjacent-files',
    // Mount theme directory so the cp step in blueprint can find it
    `--mount=${THEME_PATH}:/wordpress/wp-content/themes/${THEME_ID}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let bootLog = '';
  proc.stderr?.on('data', (d: Buffer) => { bootLog += d.toString(); });
  proc.stdout?.on('data', (d: Buffer) => { bootLog += d.toString(); });

  // Wait for the port to open (playground writes ready logs after setup)
  try {
    await waitForPort(port, 120_000);
    // Give it an extra moment for blueprint steps to finish
    await new Promise(r => setTimeout(r, 3000));
    console.log(`✅ Playground is up at ${siteUrl}`);
  } catch {
    console.error(`❌ Playground failed to start. Last logs:\n${bootLog.slice(-2000)}`);
    proc.kill();
    await fsp.unlink(bpPath).catch(() => undefined);
    process.exit(1);
  }

  // ── Crawl ──────────────────────────────────────────────────────────────────
  const base = siteUrl;
  const pages = [
    { id: 'shop', url: '/shop/' },
    { id: 'product', url: '/product/spike-test-product/' },
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
        await page.evaluate(`document.fonts.ready`);
        await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
        await page.waitForTimeout(300);
        await page.evaluate(`window.scrollTo(0, 0)`);

        const screenshotPath = path.join(OUT_DIR, `${pg.id}-${vp}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // Compute layout signature (use string eval to avoid esbuild __name injection)
        const sig = await page.evaluate(`(function(){
          var visited = [];
          function walk(el) {
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) visited.push(el.tagName.toLowerCase() + ':' + Math.round(r.x/4)*4 + ',' + Math.round(r.y/4)*4);
            for (var i=0; i<el.children.length; i++) walk(el.children[i]);
          }
          walk(document.body);
          return visited.join('|');
        })()`).then(s => String(s));

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
  proc.kill('SIGTERM');
  await fsp.unlink(bpPath).catch(() => undefined);

  // ── Report ────────────────────────────────────────────────────────────────
  const reportPath = path.join(OUT_DIR, 'spike-a-report.json');
  await fsp.writeFile(reportPath, JSON.stringify({ themeId: THEME_ID, results }, null, 2));

  console.log(`\n📊 Spike A Summary:`);
  console.log(`   Theme:      ${THEME_ID}`);
  console.log(`   Captures:   ${results.length} (${pages.length} pages × ${VIEWPORTS.length} viewports)`);
  console.log(`   Screenshots: ${OUT_DIR}/`);
  console.log(`   Report:      ${reportPath}`);
  console.log(`\n${results.every(r => r.errors === 0) ? '✅ All pages crawled with no JS errors.' : '⚠️  Some pages had JS errors — see report for details.'}`);
}

async function runPlaywrightDemoMode() {
  console.log('📸 Demo mode — crawling https://woocommerce.com/products/ as a Playwright proof-of-concept.\n');
  const browser = await chromium.launch({ headless: true });
  await fsp.mkdir(OUT_DIR, { recursive: true });

  for (const vp of [375, 768, 1440]) {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.setViewportSize({ width: vp, height: 900 });
    await page.goto('https://woocommerce.com/', { waitUntil: 'networkidle', timeout: 30_000 });
    const sp = path.join(OUT_DIR, `demo-${vp}.png`);
    await page.screenshot({ path: sp, fullPage: false });
    console.log(`  ✅ Screenshot @ ${vp}px → ${sp}`);
    await ctx.close();
  }
  await browser.close();
  console.log('\n✅ Demo mode complete. Install wp-playground for the real spike.');
}

main().catch(err => {
  console.error('Spike A failed:', err);
  process.exit(1);
});
