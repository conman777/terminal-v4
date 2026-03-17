import { describe, expect, it } from 'vitest';
import { buildTerminalAttachmentPrefix, quoteTerminalPath } from './mobileTerminalInput';

describe('quoteTerminalPath', () => {
  it('wraps paths in double quotes', () => {
    expect(quoteTerminalPath('C:\\Users\\conor\\coding projects\\image.png'))
      .toBe('"C:\\Users\\conor\\coding projects\\image.png"');
  });

  it('escapes embedded double quotes', () => {
    expect(quoteTerminalPath('~/screenshots/my "shot".png'))
      .toBe('"~/screenshots/my \\"shot\\".png"');
  });

  it('returns an empty string for blank input', () => {
    expect(quoteTerminalPath('   ')).toBe('');
  });
});

describe('buildTerminalAttachmentPrefix', () => {
  it('quotes and joins attachment paths', () => {
    expect(buildTerminalAttachmentPrefix([
      'C:\\Users\\conor\\coding projects\\one.png',
      '~/screenshots/two.png',
    ])).toBe('"C:\\Users\\conor\\coding projects\\one.png" "~/screenshots/two.png"');
  });
});
