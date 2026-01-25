/**
 * Detects if the device has touch-like characteristics
 * Used by both useMobileDetect and useViewportHeight hooks
 */
export function isTouchLikeDevice() {
  if (typeof window === 'undefined') return false;

  const ua = navigator.userAgent || '';
  const uaMobile = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(ua);
  const uaDataMobile = navigator.userAgentData?.mobile === true;
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const noHover = window.matchMedia?.('(hover: none)')?.matches ?? false;
  const touchPoints = navigator.maxTouchPoints || 0;

  return uaMobile || uaDataMobile || coarsePointer || noHover || touchPoints > 1;
}
