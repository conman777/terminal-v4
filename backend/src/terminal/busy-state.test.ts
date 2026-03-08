import { describe, expect, it } from 'vitest';
import { outputIndicatesIdlePrompt } from './busy-state';

describe('outputIndicatesIdlePrompt', () => {
  it('detects an idle cmd prompt in terminal output', () => {
    const output = [
      'Microsoft Windows [Version 10.0.26200.7840]',
      '(c) Microsoft Corporation. All rights reserved.',
      '',
      'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects>'
    ].join('\r\n');

    expect(outputIndicatesIdlePrompt(output)).toBe(true);
  });

  it('detects prompt-only AI shells', () => {
    expect(outputIndicatesIdlePrompt('\n> \n')).toBe(true);
    expect(outputIndicatesIdlePrompt('\n❯\n')).toBe(true);
  });

  it('ignores echoed commands that still have content after the prompt', () => {
    expect(outputIndicatesIdlePrompt('C:\\Users\\conor>echo hello')).toBe(false);
  });
});
