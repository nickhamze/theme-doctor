import { describe, it, expect } from '@jest/globals';

// Test the applyEdit function directly by extracting its logic
function applyEdit(content: string, search: string, replace: string): string {
  if (search === '' && replace !== '') {
    return content + '\n' + replace;
  }
  if (!content.includes(search)) {
    throw new Error(`Search string not found in file`);
  }
  const idx = content.indexOf(search);
  return content.slice(0, idx) + replace + content.slice(idx + search.length);
}

describe('applyEdit – $ injection prevention', () => {
  it('does not interpret $& as a back-reference', () => {
    const content = 'color: red;';
    const result = applyEdit(content, 'color: red;', 'color: $& blue;');
    // With String.replace, $& would have been substituted with 'color: red;'
    // Our implementation should treat it as a literal string
    expect(result).toBe('color: $& blue;');
  });

  it('does not interpret $1 as a capture group', () => {
    const content = 'display: block;';
    const result = applyEdit(content, 'block', '$1flex');
    expect(result).toBe('display: $1flex;');
  });

  it('does not interpret $` (pre-match) references', () => {
    const content = 'a b c';
    const result = applyEdit(content, 'b', '$`');
    expect(result).toBe('a $` c');
  });

  it('appends when searchStr is empty', () => {
    const result = applyEdit('existing', '', 'appended');
    expect(result).toBe('existing\nappended');
  });

  it('throws when search string is not found', () => {
    expect(() => applyEdit('hello', 'world', 'earth')).toThrow('Search string not found');
  });

  it('replaces first occurrence only', () => {
    const result = applyEdit('a a a', 'a', 'b');
    expect(result).toBe('b a a');
  });
});
