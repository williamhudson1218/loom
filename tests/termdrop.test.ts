import { describe, it, expect } from 'vitest';
import { TERMDROP_JS } from '../src/termdrop.ts';

const { shellEscapePath, dropText, fileUrlsToPaths } = new Function(`${TERMDROP_JS}; return { shellEscapePath, dropText, fileUrlsToPaths };`)() as {
  shellEscapePath: (p: string) => string;
  dropText: (p: string[]) => string;
  fileUrlsToPaths: (s: string) => string[];
};

describe('terminal drop', () => {
  it('leaves a plain path alone', () => {
    expect(shellEscapePath('/Users/will/Pictures/shot-1.png')).toBe('/Users/will/Pictures/shot-1.png');
  });
  it('backslash-escapes spaces and shell metacharacters', () => {
    expect(shellEscapePath('/Users/will/Screen Shot (1).png')).toBe('/Users/will/Screen\\ Shot\\ \\(1\\).png');
    expect(shellEscapePath("/tmp/a'b\"c$d&e;f.png")).toBe("/tmp/a\\'b\\\"c\\$d\\&e\\;f.png");
    expect(shellEscapePath('/tmp/a\\b')).toBe('/tmp/a\\\\b');
  });
  it('single-quotes a path with a control character', () => {
    expect(shellEscapePath("/tmp/it's\nme")).toBe("'/tmp/it'\\''s\nme'");
  });
  it('joins with spaces and ends with one trailing space', () => {
    expect(dropText(['/a b', '/c'])).toBe('/a\\ b /c ');
    expect(dropText([])).toBe('');
    expect(dropText(['', '/x'])).toBe('/x ');
  });
  it('reads file:// urls from a uri-list', () => {
    expect(fileUrlsToPaths('# c\nfile:///Users/w/a%20b.png\r\nhttps://x.y/z\nfile://localhost/tmp/q.png')).toEqual(['/Users/w/a b.png', '/tmp/q.png']);
  });
});
