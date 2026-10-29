export function terminalNavigationCommand(path, shell) {
  if (typeof path !== 'string' || !path || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Choose a directory without control characters.');
  }
  const name = String(shell || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name)) {
    return `cd -- '${path.replace(/'/g, `'\\''`)}'\r`;
  }
  if (['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'].includes(name)) {
    return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'\r`;
  }
  throw new Error('Folder navigation is unavailable for this shell. Change directory in the terminal.');
}
