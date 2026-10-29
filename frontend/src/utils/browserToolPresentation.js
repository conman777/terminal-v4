const TITLES = {
  browser_open: 'Open browser tab',
  browser_navigate: 'Navigate browser tab',
  browser_snapshot: 'Read browser page',
  browser_get_images: 'List page images',
  browser_click: 'Click browser element',
  browser_type: 'Type in browser',
  browser_select: 'Select browser option',
  browser_scroll: 'Scroll browser page',
  browser_wait: 'Wait for browser page',
  browser_back: 'Go back in browser',
  browser_forward: 'Go forward in browser',
  browser_screenshot: 'Capture browser screenshot',
  browser_evaluate: 'Run JavaScript in browser',
  browser_tabs: 'View open browser tabs',
  browser_close: 'Close browser session',
  browser_release_control: 'Release browser control',
};

export function getBrowserToolDisplayInfo(toolName, input = {}) {
  const tool = toolName?.toLowerCase();
  const browserTool = tool?.replace(/^(?:terminal_v4_browser\.|mcp__terminal_v4_browser__)/, '');
  if (!Object.hasOwn(TITLES, browserTool)) return null;
  let title = TITLES[browserTool];
  if (browserTool === 'browser_tabs' && input.tabId != null) title = 'Switch browser tab';
  if (browserTool === 'browser_close' && input.tabId != null) title = 'Close browser tab';
  return {
    kind: 'other', title, browserTool, rawTool: toolName,
    server: tool === browserTool ? '' : 'terminal_v4_browser',
    detail: Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' && value ? value : JSON.stringify(value)}`).join(' · '),
    input: Object.keys(input).length ? JSON.stringify(input, null, 2) : '', inputLabel: 'Arguments',
  };
}
