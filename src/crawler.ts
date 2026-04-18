import fsp from 'node:fs/promises';
import fs from 'node:fs';
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
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

  // Inject freeze CSS
  await page.addStyleTag({ content: FREEZE_CSS });

  // Wait for fonts (use string to avoid esbuild __name injection)
  await page.evaluate(`document.fonts.ready`);

  // Scroll to bottom to trigger lazy loads, then back to top
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await page.waitForTimeout(500);
  await page.evaluate(`window.scrollTo(0, 0)`);
  await page.waitForTimeout(200);

  // Screenshot
  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshotFilename = `${templateId}-${viewport}.png`;
  const screenshotPath = path.join(screenshotDir, screenshotFilename);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Layout signature
  const layoutSignature = await computeLayoutSignature(page);

  // DOM selector check
  const domSnapshot: SelectorResult[] = [];
  for (const s of selectors) {
    const count = await page.locator(s.selector).count();
    domSnapshot.push({ selector: s.selector, found: count > 0, count, required: s.required });
  }

  // PHP log delta
  let phpLogDelta = '';
  if (phpLogPath && fs.existsSync(phpLogPath)) {
    const content = await fsp.readFile(phpLogPath, 'utf8');
    // Only capture new lines added after page load (naive: capture last N lines)
    const lines = content.split('\n').filter(Boolean);
    phpLogDelta = lines.slice(-20).join('\n');
  }

  // Axe accessibility
  let axeViolations: AxeViolation[] = [];
  try {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    axeViolations = results.violations
      .filter(v => v.impact === 'serious' || v.impact === 'critical')
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

  for (const step of flow.steps) {
    switch (step.action) {
      case 'navigate':
        await page.goto(base + (step.url ?? ''), { waitUntil: 'networkidle', timeout: 30_000 });
        lastUrl = page.url();
        break;
      case 'click':
        if (step.selector) await page.locator(step.selector).first().click();
        await page.waitForLoadState('networkidle').catch(() => undefined);
        break;
      case 'fill':
        if (step.selector && step.value) await page.locator(step.selector).fill(step.value);
        break;
      case 'select':
        if (step.selector && step.value) await page.locator(step.selector).selectOption(step.value);
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
      case 'wait':
        await page.waitForTimeout(step.value ? parseInt(step.value, 10) : 1000);
        break;
      case 'screenshot':
        // mid-flow screenshots saved to screenshotDir
        break;
    }
  }

  // Final screenshot
  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `${flow.id}-${viewport}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const layoutSignature = await computeLayoutSignature(page);

  // Save trace
  await fsp.mkdir(traceDir, { recursive: true });
  const tracePath = path.join(traceDir, `${flow.id}-${viewport}.zip`);
  await page.context().tracing.stop({ path: tracePath });

  let phpLogDelta = '';
  if (phpLogPath && fs.existsSync(phpLogPath)) {
    const content = await fsp.readFile(phpLogPath, 'utf8');
    phpLogDelta = content.split('\n').filter(Boolean).slice(-20).join('\n');
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

      // Templates
      for (const template of rubric.templates) {
        const page = await context.newPage();
        try {
          const url = resolveUrl(sandbox.url, template);
          const screenshotDir = path.join(screenshotBase, String(viewport));
          const capture = await capturePage(
            page,
            url,
            viewport,
            template.id,
            template.selectors,
            sandbox.phpLogPath,
            screenshotDir,
          );
          captures.push(capture);
        } finally {
          await page.close();
        }
      }

      // Flows
      for (const flow of rubric.flows) {
        const page = await context.newPage();
        try {
          const screenshotDir = path.join(screenshotBase, String(viewport));
          const traceDir      = path.join(traceBase, String(viewport));
          const capture = await runFlow(page, sandbox.url, flow, viewport, sandbox.phpLogPath, traceDir, screenshotDir);
          captures.push(capture);
        } finally {
          await page.close();
        }
      }

      await context.close();
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
