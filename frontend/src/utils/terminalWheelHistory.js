export function shouldCheckHistoryAtTopOnWheel({ deltaY, isMobile, usesTmux, baseY }) {
  if (!(deltaY < 0)) return false;
  if (isMobile) return true;
  if (!usesTmux) return true;
  return (baseY || 0) > 0;
}
