import { describe, expect, it } from 'vitest';
import { getTerminalPlatformConfig, resolveTerminalSurface } from './terminalSurface';

describe('terminalSurface', () => {
  it('prefers an explicit desktop surface over mobile detection', () => {
    expect(resolveTerminalSurface('desktop', true)).toBe('desktop');
  });

  it('prefers an explicit mobile surface over desktop detection', () => {
    expect(resolveTerminalSurface('mobile', false)).toBe('mobile');
  });

  it('falls back to detected device mode when no surface is provided', () => {
    expect(resolveTerminalSurface(undefined, true)).toBe('mobile');
    expect(resolveTerminalSurface(undefined, false)).toBe('desktop');
  });

  it('returns desktop defaults for the desktop terminal surface', () => {
    expect(getTerminalPlatformConfig({
      surface: 'desktop',
      fontSize: undefined,
      webglEnabled: true,
    })).toEqual({
      surface: 'desktop',
      isMobile: false,
      rootClassName: 'terminal-chat-desktop',
      fontSize: 14,
      history: {
        initialEvents: 750,
        initialChars: 200_000,
        pageEvents: 5000,
        pageChars: 1_000_000,
        maxEvents: 100_000,
        maxChars: 20_000_000,
        writeChunkChars: 120_000,
      },
      scrollback: 100_000,
      readerMaxLines: null,
      webglEnabled: true,
    });
  });

  it('returns mobile defaults for the mobile terminal surface', () => {
    expect(getTerminalPlatformConfig({
      surface: 'mobile',
      fontSize: undefined,
      webglEnabled: true,
    })).toEqual({
      surface: 'mobile',
      isMobile: true,
      rootClassName: 'terminal-chat-mobile',
      fontSize: 16,
      history: {
        initialEvents: 250,
        initialChars: 80_000,
        pageEvents: 1000,
        pageChars: 300_000,
        maxEvents: 10_000,
        maxChars: 2_000_000,
        writeChunkChars: 80_000,
      },
      scrollback: 10_000,
      readerMaxLines: 2_000,
      webglEnabled: false,
    });
  });
});
