import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import type {
  EvidenceCapture,
  EvidencePacket,
  Rubric,
  RubricFlow,
  ConsoleMessage,
  NetworkFailure,
  AxeViolation,
  SelectorResult,
  Viewport,
  RunContext,
  RubricTemplate,
} from './types.js';
import { computeLayoutSignature } from './signature.js';
import type { SandboxBootResult } from './sandbox/types.js';

// Pass 8: per-page capture timeout (guards against hung networkidle/fonts)
const PAGE_CAPTURE_TIMEOUT_MS = 90_000;

// Pass 21: cap screenshot height to avoid gigantic full-page PNGs
const MAX_SCREENSHOT_HEIGHT_PX = 10_000;

// Pass 21: read only the last N bytes of a PHP log (avoid loading huge files)
const PHP_LOG_TAIL_BYTES = 4096;

// ─── Freeze CSS injected into every page ──────────────────────────────────────

const FREEZE_CSS = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
`;

const FREEZE_CLOCK_TIME = '2025-01-15T12:00:00.000Z';

const EXTERNAL_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'gravatar.com',
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.com',
  'connect.facebook.net',
];

function isExternalRequest(url: string, siteOrigin: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin === siteOrigin) return false;
    return EXTERNAL_ORIGINS.some(o => u.hostname.includes(o)) || u.origin !== siteOrigin;
  } catch {
    return false;
  }
}

// ─── Resolve template URL ──────────────────────────────────────────────────────

function resolveUrl(
  base: string,
  template: RubricTemplate,
  urlParams: Record<string, string> = {},
): string {
  let url = template.urlPattern;
  const params = { ...template.urlParams, ...urlParams };
  for (const [k, v] of Object.entries(params)) {
    url = url.replace(`{${k}}`, encodeURIComponent(v));
  }
  return base.replace(/\/$/, '') + url;
}

// ─── Capture a single page ────────────────────────────────────────────────────

async function capturePage(
  page: Page,
  url: string,
  viewport: Viewport,
  templateId: string,
  selectors: { selector: string; required: boolean; description?: string }[],
  phpLogPath: string | undefined,
  screenshotDir: string,
): Promise<EvidenceCapture> {
  const start = Date.now();

  // Freeze clock
  await page.clock.install({ time: FREEZE_CLOCK_TIME });

  // Block external requests
  const siteOrigin = new URL(url).origin;
  await page.route('**/*', (route) => {
    if (isExternalRequest(route.request().url(), siteOrigin)) {
      route.abort().catch(() => undefined);
    } else {
      route.continue().catch(() => undefined);
    }
  });

  const consoleMessages: ConsoleMessage[] = [];
  const networkFailures: NetworkFailure[] = [];

  page.on('console', msg => {
    const type = msg.type() as ConsoleMessage['type'];
    if (type === 'error' || type === 'warning') {
      consoleMessages.push({ type, text: msg.text(), url });
    }
  });

  page.on('response', resp => {
    const status = resp.status();
    if (status >= 400) {
      networkFailures.push({
        url:    resp.url(),
        status,
        method: resp.request().method(),
      });
    }
  });

  await page.setViewportSize({ width: viewport, height: 900 });

  // Pass 8: try networkidle first, fall back to load to handle WebSocket/streaming pages
  // Pass 24: check HTTP status and flag 4xx/5xx as functional failures
  let httpStatus = 200;
  page.on('response', resp => {
    if (resp.url() === url && resp.status() >= 400) {
      httpStatus = resp.status();
    }
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 });
  } catch {
    // Fallback: load event is usually sufficient
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  }

  if (httpStatus >= 400) {
    consoleMessages.push({
      type: 'error',
      text: `Page returned HTTP ${httpStatus}`,
      url,
    });
  }

  // Inject freeze CSS
  await page.addStyleTag({ content: FREEZE_CSS });

  // Wait for fonts (use string to avoid esbuild __name injection)
  await page.evaluate(`document.fonts.ready`);

  // Scroll to bottom to trigger lazy loads, then back to top
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await page.waitForTimeout(500);
  await page.evaluate(`window.scrollTo(0, 0)`);
  await page.waitForTimeout(200);

  // Pass 21: cap screenshot height to avoid multi-gigabyte PNGs on infinite-scroll pages
  await fsp.mkdir(screenshotDir, { recursive: true });
  // Sanitize templateId before using in filename (defense-in-depth on top of Zod rubric check)
  const safeTemplateId = templateId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  const screenshotFilename = `${safeTemplateId}-${viewport}.png`;
  const screenshotPath = path.join(screenshotDir, screenshotFilename);
  const pageHeight: number = await page.evaluate(`Math.min(document.body.scrollHeight, ${MAX_SCREENSHOT_HEIGHT_PX})`) as number;
  await page.screenshot({
    path: screenshotPath,
    clip: { x: 0, y: 0, width: viewport, height: Math.max(900, pageHeight) },
  });

  // Layout signature
  const layoutSignature = await computeLayoutSignature(page);

  // DOM selector check
  const domSnapshot: SelectorResult[] = [];
  for (const s of selectors) {
    const count = await page.locator(s.selector).count();
    domSnapshot.push({ selector: s.selector, found: count > 0, count, required: s.required });
  }

  // Pass 21: read only the tail of the PHP log to avoid loading huge files
  let phpLogDelta = '';
  if (phpLogPath) {
    try {
      const stat = await fsp.stat(phpLogPath);
      if (stat.size > 0) {
        const start = Math.max(0, stat.size - PHP_LOG_TAIL_BYTES);
        const fh = await fsp.open(phpLogPath, 'r');
        try {
          const buf = Buffer.alloc(Math.min(PHP_LOG_TAIL_BYTES, stat.size));
          await fh.read(buf, 0, buf.length, start);
          phpLogDelta = buf.toString('utf8').split('\n').filter(Boolean).slice(-20).join('\n');
        } finally {
          await fh.close();
        }
      }
    } catch { /* non-fatal */ }
  }

  // Axe accessibility
  let axeViolations: AxeViolation[] = [];
  try {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    // Pass 24: include moderate (cosmetic-tier) + serious/critical (functional-tier)
    axeViolations = results.violations
      .filter(v => v.impact === 'moderate' || v.impact === 'serious' || v.impact === 'critical')
      .map(v => ({
        id:          v.id,
        impact:      v.impact ?? '',
        description: v.description,
        nodes:       v.nodes.length,
      }));
  } catch {
    // axe failure is non-fatal
  }

  return {
    templateId,
    viewport,
    url,
    screenshotPath,
    layoutSignature,
    domSnapshot,
    consoleMessages,
    networkFailures,
    phpLogDelta,
    axeViolations,
    capturedAt:  new Date().toISOString(),
    durationMs:  Date.now() - start,
  };
}

// ─── Run a multi-step flow ─────────────────────────────────────────────────────

async function runFlow(
  page: Page,
  base: string,
  flow: RubricFlow,
  viewport: Viewport,
  phpLogPath: string | undefined,
  traceDir: string,
  screenshotDir: string,
): Promise<EvidenceCapture> {
  const start = Date.now();
  const consoleMessages: ConsoleMessage[] = [];
  const networkFailures: NetworkFailure[] = [];

  const siteOrigin = new URL(base).origin;
  await page.route('**/*', (route) => {
    if (isExternalRequest(route.request().url(), siteOrigin)) {
      route.abort().catch(() => undefined);
    } else {
      route.continue().catch(() => undefined);
    }
  });

  page.on('console', msg => {
    const type = msg.type() as ConsoleMessage['type'];
    if (type === 'error' || type === 'warning') {
      consoleMessages.push({ type, text: msg.text() });
    }
  });
  page.on('response', resp => {
    if (resp.status() >= 400) {
      networkFailures.push({ url: resp.url(), status: resp.status(), method: resp.request().method() });
    }
  });

  await page.setViewportSize({ width: viewport, height: 900 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (page as any).clock.install({ time: FREEZE_CLOCK_TIME });
  await page.addStyleTag({ content: FREEZE_CSS });

  // Start tracing
  await page.context().tracing.start({ screenshots: true, snapshots: true });

  let lastUrl = base;

  // Pass 8: per-step timeout to prevent a hung click/navigate from blocking forever
  const STEP_TIMEOUT_MS = 20_000;

  for (const step of flow.steps) {
    switch (step.action) {
      case 'navigate':
        try {
          await page.goto(base + (step.url ?? ''), { waitUntil: 'networkidle', timeout: STEP_TIMEOUT_MS });
        } catch {
          await page.goto(base + (step.url ?? ''), { waitUntil: 'load', timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
        }
        lastUrl = page.url();
        break;
      case 'click':
        if (step.selector) {
          await page.locator(step.selector).first().click({ timeout: STEP_TIMEOUT_MS });
          await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
        }
        break;
      case 'fill':
        if (step.selector && step.value) {
          await page.locator(step.selector).fill(step.value, { timeout: STEP_TIMEOUT_MS });
        }
        break;
      case 'select':
        if (step.selector && step.value) {
          await page.locator(step.selector).selectOption(step.value, { timeout: STEP_TIMEOUT_MS });
        }
        break;
      case 'assert':
        if (step.selector) {
          const count = await page.locator(step.selector).count();
          if (count === 0) {
            consoleMessages.push({
              type:  'error',
              text:  `Flow assertion failed: "${step.selector}" not found`,
              url:   page.url(),
            });
          }
        }
        break;
      case 'wait': {
        const waitMs = step.value ? Math.min(parseInt(step.value, 10), 10_000) : 1000; // cap at 10s
        await page.waitForTimeout(waitMs);
        break;
      }
      case 'screenshot':
        break;
    }
  }

  // Final screenshot — sanitize flow ID for use in filename
  const safeFlowId = flow.id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `${safeFlowId}-${viewport}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const layoutSignature = await computeLayoutSignature(page);

  // Save trace
  await fsp.mkdir(traceDir, { recursive: true });
  const tracePath = path.join(traceDir, `${safeFlowId}-${viewport}.zip`);
  await page.context().tracing.stop({ path: tracePath });

  let phpLogDelta = '';
  if (phpLogPath) {
    try {
      const stat = await fsp.stat(phpLogPath);
      if (stat.size > 0) {
        const start = Math.max(0, stat.size - PHP_LOG_TAIL_BYTES);
        const fh = await fsp.open(phpLogPath, 'r');
        try {
          const buf = Buffer.alloc(Math.min(PHP_LOG_TAIL_BYTES, stat.size));
          await fh.read(buf, 0, buf.length, start);
          phpLogDelta = buf.toString('utf8').split('\n').filter(Boolean).slice(-20).join('\n');
        } finally {
          await fh.close();
        }
      }
    } catch { /* non-fatal */ }
  }

  return {
    templateId:      flow.id,
    viewport,
    url:             lastUrl,
    screenshotPath,
    layoutSignature,
    domSnapshot:     [],
    consoleMessages,
    networkFailures,
    phpLogDelta,
    axeViolations:   [],
    tracePath,
    capturedAt:      new Date().toISOString(),
    durationMs:      Date.now() - start,
  };
}

// Pass 8: wrap a single page operation with a hard timeout
async function withPageTimeout<T>(op: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    op(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Page timeout (${timeoutMs}ms): ${label}`)), timeoutMs),
    ),
  ]);
}

// ─── Main crawl function ──────────────────────────────────────────────────────

export async function crawlTheme(
  ctx: RunContext,
  sandbox: SandboxBootResult,
  rubric: Rubric,
  viewports: Viewport[],
): Promise<EvidencePacket> {
  const screenshotBase = path.join(ctx.configDir, 'reports', ctx.runId, ctx.themeId, 'screenshots');
  const traceBase      = path.join(ctx.configDir, 'reports', ctx.runId, ctx.themeId, 'traces');

  const browser: Browser = await chromium.launch({ headless: true });
  const captures: EvidenceCapture[] = [];

  try {
    for (const viewport of viewports) {
      const context: BrowserContext = await browser.newContext();
      try {
        // Templates
        for (const template of rubric.templates) {
          const page = await context.newPage();
          try {
            const url = resolveUrl(sandbox.url, template);
            const screenshotDir = path.join(screenshotBase, String(viewport));
            // Pass 8: enforce per-page hard timeout
            const capture = await withPageTimeout(
              () => capturePage(page, url, viewport, template.id, template.selectors, sandbox.phpLogPath, screenshotDir),
              PAGE_CAPTURE_TIMEOUT_MS,
              `${template.id}@${viewport}`,
            );
            captures.push(capture);
          } catch (err) {
            // Non-fatal: record as functional failure so judge can surface it
            captures.push({
              templateId:      template.id,
              viewport,
              url:             resolveUrl(sandbox.url, template),
              screenshotPath:  '',
              layoutSignature: '',
              domSnapshot:     [],
              consoleMessages: [{ type: 'error', text: `Capture failed: ${err instanceof Error ? err.message : String(err)}`, url: '' }],
              networkFailures: [],
              phpLogDelta:     '',
              axeViolations:   [],
              capturedAt:      new Date().toISOString(),
              durationMs:      0,
            });
          } finally {
            await page.close().catch(() => undefined);
          }
        }

        // Flows
        for (const flow of rubric.flows) {
          const page = await context.newPage();
          try {
            const screenshotDir = path.join(screenshotBase, String(viewport));
            const traceDir      = path.join(traceBase, String(viewport));
            const capture = await withPageTimeout(
              () => runFlow(page, sandbox.url, flow, viewport, sandbox.phpLogPath, traceDir, screenshotDir),
              PAGE_CAPTURE_TIMEOUT_MS,
              `flow:${flow.id}@${viewport}`,
            );
            captures.push(capture);
          } catch (err) {
            captures.push({
              templateId:      flow.id,
              viewport,
              url:             sandbox.url,
              screenshotPath:  '',
              layoutSignature: '',
              domSnapshot:     [],
              consoleMessages: [{ type: 'error', text: `Flow failed: ${err instanceof Error ? err.message : String(err)}`, url: '' }],
              networkFailures: [],
              phpLogDelta:     '',
              axeViolations:   [],
              capturedAt:      new Date().toISOString(),
              durationMs:      0,
            });
          } finally {
            await page.close().catch(() => undefined);
          }
        }
      } finally {
        // Bug fix: close context in finally so it's released even if a page throws
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close();
  }

  return {
    runId:     ctx.runId,
    themeId:   ctx.themeId,
    matrix:    ctx.matrix,
    captures,
    createdAt: new Date().toISOString(),
  };
}
