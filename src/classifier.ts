import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ThemeClassification, ThemeType } from './types.js';

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
  if (!fs.existsSync(functionsPath)) return false;
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
  // Check for block-checkout page template
  const tplDirs = ['templates', 'block-templates', 'parts'];
  for (const dir of tplDirs) {
    const tplDir = path.join(themeDir, dir);
    if (!fs.existsSync(tplDir)) continue;
    const files = await fsp.readdir(tplDir);
    for (const f of files) {
      if (f.includes('checkout') && (f.endsWith('.html') || f.endsWith('.php'))) {
        const content = await fsp.readFile(path.join(tplDir, f), 'utf8');
        if (content.includes('woocommerce/checkout') || content.includes('wp:woocommerce/checkout')) {
          return 'block';
        }
      }
    }
  }
  // Check functions.php for shortcode
  const fnPath = path.join(themeDir, 'functions.php');
  if (fs.existsSync(fnPath)) {
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
  if (!fs.existsSync(themeJsonPath)) return 'classic';

  const themeJson = JSON.parse(await fsp.readFile(themeJsonPath, 'utf8'));

  // FSE if it has a templates directory with block templates
  const templatesDirs = ['templates', 'block-templates'];
  for (const dir of templatesDirs) {
    const p = path.join(themeDir, dir);
    if (fs.existsSync(p)) {
      const files = await fsp.readdir(p);
      const htmlFiles = files.filter(f => f.endsWith('.html'));
      if (htmlFiles.length > 0) return 'fse';
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
    if (!fs.existsSync(p)) continue;
    const files = await fsp.readdir(p);
    results.push(...files.filter(f => f.endsWith('.html')).map(f => `${dir}/${f}`));
  }
  return results;
}

async function listBlockParts(themeDir: string): Promise<string[]> {
  const dirs = ['parts', 'block-template-parts', 'template-parts'];
  const results: string[] = [];
  for (const dir of dirs) {
    const p = path.join(themeDir, dir);
    if (!fs.existsSync(p)) continue;
    const files = await fsp.readdir(p);
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
  return candidates.some(c => fs.existsSync(path.join(themeDir, c)));
}

// ─── Main classifier ──────────────────────────────────────────────────────────

export async function classifyTheme(themeDir: string): Promise<ThemeClassification> {
  const styleCssPath = path.join(themeDir, 'style.css');
  let header: Record<string, string> = {};
  if (fs.existsSync(styleCssPath)) {
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
