import { describe, it, expect } from '@jest/globals';
import { isDenylisted, sanitizeId } from '../safety.js';

describe('isDenylisted', () => {
  it('blocks style.css', () => expect(isDenylisted('style.css')).toBe(true));
  it('blocks theme.json', () => expect(isDenylisted('theme.json')).toBe(true));
  it('blocks .env', () => expect(isDenylisted('.env')).toBe(true));
  it('blocks .env.local', () => expect(isDenylisted('.env.local')).toBe(true));
  it('blocks wp-config.php', () => expect(isDenylisted('wp-config.php')).toBe(true));
  it('blocks package.json', () => expect(isDenylisted('package.json')).toBe(true));
  it('blocks package-lock.json', () => expect(isDenylisted('package-lock.json')).toBe(true));
  it('blocks composer.lock', () => expect(isDenylisted('composer.lock')).toBe(true));
  it('blocks yarn.lock', () => expect(isDenylisted('yarn.lock')).toBe(true));
  it('blocks nested .env', () => expect(isDenylisted('config/.env')).toBe(true));
  it('allows single-product.php', () => expect(isDenylisted('woocommerce/single-product.php')).toBe(false));
  it('allows main.css', () => expect(isDenylisted('assets/main.css')).toBe(false));
  it('allows functions.php', () => expect(isDenylisted('functions.php')).toBe(false));
});

describe('sanitizeId', () => {
  it('passes clean IDs', () => expect(sanitizeId('my-theme')).toBe('my-theme'));
  it('strips path traversal', () => expect(sanitizeId('../../../etc/passwd')).not.toContain('..'));
  it('strips path traversal and produces non-empty result', () => {
    const result = sanitizeId('../../../etc/passwd');
    expect(result.length).toBeGreaterThan(0);
  });
  it('strips slashes', () => {
    const result = sanitizeId('foo/bar');
    expect(result).not.toContain('/');
  });
  it('strips backslashes', () => {
    const result = sanitizeId('foo\\bar');
    expect(result).not.toContain('\\');
  });
  it('strips null bytes', () => expect(sanitizeId('evil\x00name')).not.toContain('\x00'));
  it('caps length at 128', () => expect(sanitizeId('a'.repeat(200)).length).toBeLessThanOrEqual(128));
  it('removes leading dots', () => expect(sanitizeId('.hidden')).not.toMatch(/^\./));
});
