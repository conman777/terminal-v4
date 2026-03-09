export function resolveTerminalSurface(surface, detectedIsMobile) {
  if (surface === 'mobile' || surface === 'desktop') {
    return surface;
  }

  return detectedIsMobile ? 'mobile' : 'desktop';
}

export function getTerminalPlatformConfig({ surface, fontSize, webglEnabled }) {
  const isMobile = surface === 'mobile';

  return {
    surface,
    isMobile,
    rootClassName: isMobile ? 'terminal-chat-mobile' : 'terminal-chat-desktop',
    fontSize: fontSize || (isMobile ? 16 : 14),
    history: {
      initialEvents: isMobile ? 250 : 750,
      initialChars: isMobile ? 80_000 : 200_000,
      pageEvents: isMobile ? 1000 : 5000,
      pageChars: isMobile ? 300_000 : 1_000_000,
      maxEvents: isMobile ? 10_000 : 100_000,
      maxChars: isMobile ? 2_000_000 : 20_000_000,
      writeChunkChars: isMobile ? 80_000 : 120_000,
    },
    scrollback: isMobile ? 10_000 : 100_000,
    readerMaxLines: isMobile ? 2_000 : null,
    webglEnabled: Boolean(webglEnabled) && !isMobile,
  };
}
