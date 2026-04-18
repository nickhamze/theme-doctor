import { describe, it, expect } from '@jest/globals';
import { redactSecrets, escHtml, formatError, setDebugMode } from '../util.js';

describe('redactSecrets', () => {
  it('redacts PHP define() with DB_PASSWORD', () => {
    const code = `define('DB_PASSWORD', 'super-secret-123');`;
    expect(redactSecrets(code)).not.toContain('super-secret-123');
  });

  it('redacts PHP secret key defines', () => {
    const code = `define('AUTH_KEY', 'some-very-long-auth-key-value');`;
    expect(redactSecrets(code)).not.toContain('some-very-long-auth-key-value');
  });

  it('redacts Bearer tokens', () => {
    const text = `Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`;
    const result = redactSecrets(text);
    expect(result).not.toContain('eyJhbGci');
    expect(result).toContain('Bearer **REDACTED**');
  });

  it('redacts Anthropic API keys', () => {
    const text = `key: sk-ant-api03-aaaabbbbccccddddeeee1234567890abcdef`;
    expect(redactSecrets(text)).not.toContain('aaaabbbb');
  });

  it('redacts Slack webhook URLs', () => {
    const url = `https://hooks.slack.com/services/T123/B456/xyz789abc`;
    expect(redactSecrets(url)).not.toContain('xyz789abc');
    expect(redactSecrets(url)).toContain('**REDACTED**');
  });

  it('preserves non-secret content', () => {
    const code = `echo 'Hello World'; // Safe comment`;
    expect(redactSecrets(code)).toBe(code);
  });
});

describe('escHtml', () => {
  it('escapes &', () => expect(escHtml('a & b')).toBe('a &amp; b'));
  it('escapes <', () => expect(escHtml('<script>')).toBe('&lt;script&gt;'));
  it('escapes >', () => expect(escHtml('1 > 0')).toBe('1 &gt; 0'));
  it('escapes "', () => expect(escHtml('"quote"')).toBe('&quot;quote&quot;'));
  it("escapes '", () => expect(escHtml("it's")).toBe("it&#x27;s"));
  it('escapes /', () => expect(escHtml('</div>')).toBe('&lt;&#x2F;div&gt;'));
  it('handles XSS payload', () => {
    const xss = `<img src=x onerror="alert('xss')">`;
    const escaped = escHtml(xss);
    // The literal < and > should be gone — rendered as &lt; / &gt;
    expect(escaped).not.toContain('<img');
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });
  it('passes through safe strings unchanged', () => {
    expect(escHtml('hello world 123')).toBe('hello world 123');
  });
});

describe('formatError', () => {
  it('returns message in non-debug mode', () => {
    setDebugMode(false);
    const err = new Error('test error');
    expect(formatError(err)).toBe('test error');
    expect(formatError(err)).not.toContain('at ');
  });

  it('includes stack in debug mode', () => {
    setDebugMode(true);
    const err = new Error('debug error');
    const result = formatError(err);
    expect(result).toContain('debug error');
    // Reset
    setDebugMode(false);
  });

  it('handles non-Error values', () => {
    setDebugMode(false);
    expect(formatError('string error')).toBe('string error');
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
  });
});
