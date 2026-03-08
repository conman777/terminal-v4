function getNavigatorLike(navigatorLike) {
  if (navigatorLike) return navigatorLike;
  if (typeof navigator !== 'undefined') return navigator;
  return null;
}

export function isLinuxDesktopBrowser(navigatorLike) {
  const runtimeNavigator = getNavigatorLike(navigatorLike);
  if (!runtimeNavigator) return false;

  const platform = [
    runtimeNavigator.userAgentData?.platform,
    runtimeNavigator.platform,
    runtimeNavigator.userAgent,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!platform || platform.includes('android')) {
    return false;
  }

  return platform.includes('linux') || platform.includes('x11');
}

export function resolveTerminalWebglEnabled(preferredEnabled, navigatorLike) {
  if (isLinuxDesktopBrowser(navigatorLike)) {
    return false;
  }
  return preferredEnabled !== false;
}

export function getTerminalRendererGuardReason(navigatorLike) {
  if (!isLinuxDesktopBrowser(navigatorLike)) {
    return null;
  }
  return 'WebGL is disabled on Linux desktops because xterm can corrupt terminal output in this environment.';
}
