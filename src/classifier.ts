import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ThemeClassification, ThemeType } from './types.js';

async function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(() => true).catch(() => false);
}

// ─── style.css header parser ─────────────────────────────────────────────────

function parseStyleHeader(content: string): Record<string, string> {
  const block = content.match(/\/\*[\s\S]*?\*\//)?.[0] ?? '';
  const result: Record<string, string> = {};
  for (const [, key, value] of block.matchAll(/^\s*([^:]+?):\s*(.+)$/gm)) {
    result[key.trim().toLowerCase().replace(/\s+/g, '-')] = value.trim();
  }
  return result;
}

// ─── HPOS check ───────────────────────────────────────────────────────────────

async function checkHposAware(themeDir: string): Promise<boolean> {
  const functionsPath = path.join(themeDir, 'functions.php');
  if (!(await exists(functionsPath))) return false;
  const content = await fsp.readFile(functionsPath, 'utf8');
  return content.includes('woocommerce_hpos_enabled') ||
    content.includes('CustomOrdersTableController') ||
    content.includes('FeaturesUtil') ||
    content.includes('declare_compatibility') ||
    content.includes('custom_order_tables');
}

// ─── Checkout type detection ──────────────────────────────────────────────────

async function detectCheckoutType(
  themeDir: string,
): Promise<'shortcode' | 'block' | 'unknown'> {
  const tplDirs = ['templates', 'block-templates', 'parts'];
  for (const dir of tplDirs) {
    const tplDir = path.join(themeDir, dir);
    if (!(await exists(tplDir))) continue;
    let files: string[];
    try {
      files = await fsp.readdir(tplDir);
    } catch { continue; }
    for (const f of files) {
      if (f.includes('checkout') && (f.endsWith('.html') || f.endsWith('.php'))) {
        try {
          const content = await fsp.readFile(path.join(tplDir, f), 'utf8');
          if (content.includes('woocommerce/checkout') || content.includes('wp:woocommerce/checkout')) {
            return 'block';
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }
  const fnPath = path.join(themeDir, 'functions.php');
  if (await exists(fnPath)) {
    const content = await fsp.readFile(fnPath, 'utf8');
    if (content.includes('[woocommerce_checkout]') || content.includes('woocommerce_checkout')) {
      return 'shortcode';
    }
  }
  return 'unknown';
}

// ─── FSE / hybrid detection ───────────────────────────────────────────────────

async function detectThemeType(themeDir: string): Promise<ThemeType> {
  const themeJsonPath = path.join(themeDir, 'theme.json');
  if (!(await exists(themeJsonPath))) return 'classic';

  // Bug fix: JSON.parse wrapped in try/catch — malformed theme.json must not crash
  let themeJson: unknown = null;
  try {
    themeJson = JSON.parse(await fsp.readFile(themeJsonPath, 'utf8'));
  } catch {
    // Malformed theme.json — treat as classic theme
    return 'classic';
  }

  // FSE if it has a templates directory with block templates
  const templatesDirs = ['templates', 'block-templates'];
  for (const dir of templatesDirs) {
    const p = path.join(themeDir, dir);
    if (await exists(p)) {
      const files = await fsp.readdir(p).catch(() => [] as string[]);
      if (files.some(f => f.endsWith('.html'))) return 'fse';
    }
  }

  // Hybrid if it has theme.json but no block templates
  if (themeJson) return 'hybrid';
  return 'classic';
}

// ─── Block templates + parts ──────────────────────────────────────────────────

async function listBlockTemplates(themeDir: string): Promise<string[]> {
  const dirs = ['templates', 'block-templates'];
  const results: string[] = [];
  for (const dir of dirs) {
    const p = path.join(themeDir, dir);
    if (!(await exists(p))) continue;
    const files = await fsp.readdir(p).catch(() => [] as string[]);
    results.push(...files.filter(f => f.endsWith('.html')).map(f => `${dir}/${f}`));
  }
  return results;
}

async function listBlockParts(themeDir: string): Promise<string[]> {
  const dirs = ['parts', 'block-template-parts', 'template-parts'];
  const results: string[] = [];
  for (const dir of dirs) {
    const p = path.join(themeDir, dir);
    if (!(await exists(p))) continue;
    const files = await fsp.readdir(p).catch(() => [] as string[]);
    results.push(...files.filter(f => f.endsWith('.html')).map(f => `${dir}/${f}`));
  }
  return results;
}

// ─── Custom product templates ─────────────────────────────────────────────────

async function hasCustomProductTemplate(themeDir: string): Promise<boolean> {
  const candidates = [
    'woocommerce/single-product.php',
    'woocommerce/content-single-product.php',
    'woocommerce/archive-product.php',
  ];
  const checks = await Promise.all(candidates.map(c => exists(path.join(themeDir, c))));
  return checks.some(Boolean);
}

// ─── Main classifier ──────────────────────────────────────────────────────────

export async function classifyTheme(themeDir: string): Promise<ThemeClassification> {
  const styleCssPath = path.join(themeDir, 'style.css');
  let header: Record<string, string> = {};
  if (await exists(styleCssPath)) {
    const content = await fsp.readFile(styleCssPath, 'utf8');
    header = parseStyleHeader(content);
  }

  const [type, hposAware, checkoutType, hasCustomProductTpl, blockTemplates, blockParts] =
    await Promise.all([
      detectThemeType(themeDir),
      checkHposAware(themeDir),
      detectCheckoutType(themeDir),
      hasCustomProductTemplate(themeDir),
      listBlockTemplates(themeDir),
      listBlockParts(themeDir),
    ]);

  return {
    type,
    hposAware,
    checkoutType,
    hasCustomProductTpl,
    blockTemplates,
    blockParts,
    name:       header['theme-name'] ?? header['name'] ?? path.basename(themeDir),
    version:    header['version'] ?? '0.0.0',
    textDomain: header['text-domain'] ?? '',
  };
}
