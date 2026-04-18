import crypto from 'node:crypto';
import type { Page } from 'playwright';

export interface BoxNode {
  tag:      string;
  role:     string;
  x:        number;
  y:        number;
  w:        number;
  h:        number;
  children: BoxNode[];
}

// Selectors that contain dynamic/nonce-y content we want to mask
const MASK_SELECTORS = [
  '[name="_wpnonce"]',
  '[name="woocommerce-login-nonce"]',
  '[name="shop_notice"]',
  'input[type="hidden"][name*="nonce"]',
];

// Tags we skip to keep the signature stable
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'meta', 'link', 'svg', 'path']);

export async function computeLayoutSignature(page: Page): Promise<string> {
  // Use string-based evaluate to avoid esbuild __name injection in serialized functions
  const skipTagsJson = JSON.stringify([...SKIP_TAGS]);
  const maskSelectorsJson = JSON.stringify(MASK_SELECTORS);

  // Mask dynamic elements
  await page.evaluate(`(function(){
    var selectors = ${maskSelectorsJson};
    selectors.forEach(function(sel) {
      document.querySelectorAll(sel).forEach(function(el) {
        el.setAttribute('data-td-masked','1');
        if (el.tagName==='INPUT') el.value='__masked__';
      });
    });
  })()`);

  const tree = await page.evaluate(`(function(){
    var skipTags = ${skipTagsJson};
    var MAX_DEPTH = 64;    // Bug fix: cap recursion depth to prevent stack overflow
    var MAX_NODES = 2000;  // Cap total nodes to prevent O(n) blowup on huge pages
    var nodeCount = 0;
    function serialize(el, depth) {
      if (depth > MAX_DEPTH || nodeCount >= MAX_NODES) return null;
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (!tag || skipTags.indexOf(tag) !== -1) return null;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      nodeCount++;
      var role = el.getAttribute('role') || tag;
      var children = [];
      for (var i = 0; i < el.children.length; i++) {
        var s = serialize(el.children[i], depth + 1);
        if (s) children.push(s);
      }
      return {
        tag: tag, role: role,
        x: Math.round(rect.left/4)*4,
        y: Math.round(rect.top/4)*4,
        w: Math.round(rect.width/4)*4,
        h: Math.round(rect.height/4)*4,
        children: children
      };
    }
    return document.body ? serialize(document.body, 0) : null;
  })()`) as BoxNode | null;

  const canonical = JSON.stringify(tree);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function diffSignatures(a: string, b: string): boolean {
  return a !== b;
}
