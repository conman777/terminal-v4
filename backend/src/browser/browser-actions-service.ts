/**
 * Browser Actions Service
 *
 * Implements all browser actions: navigation, interaction, page info, and waiting.
 */

import { BrowserSession, LogEntry } from './browser-session-service.js';

// Allowed ports for security
const MIN_PORT = 3000;
const MAX_PORT = 9999;

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Allow localhost with ports 3000-9999
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const port = parseInt(parsed.port, 10);
      if (!parsed.port) return true; // No port specified, allow
      return port >= MIN_PORT && port <= MAX_PORT;
    }
    // Allow preview subdomains
    if (parsed.hostname.match(/^preview-\d+\./)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ============ NAVIGATION ============

export interface GotoOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export async function goto(session: BrowserSession, url: string, options: GotoOptions = {}): Promise<{
  success: boolean;
  url: string;
  title: string;
  error?: string;
}> {
  if (!isAllowedUrl(url)) {
    return { success: false, url, title: '', error: 'URL not allowed. Only localhost:3000-9999 and preview subdomains permitted.' };
  }

  try {
    await session.page.goto(url, {
      waitUntil: options.waitUntil || 'load',
      timeout: options.timeout || 30000
    });
    session.currentUrl = session.page.url();
    session.lastActivity = Date.now();

    return {
      success: true,
      url: session.page.url(),
      title: await session.page.title()
    };
  } catch (err: any) {
    return {
      success: false,
      url,
      title: '',
      error: err.message
    };
  }
}

export async function goBack(session: BrowserSession): Promise<{ success: boolean; url: string }> {
  try {
    await session.page.goBack();
    session.currentUrl = session.page.url();
    session.lastActivity = Date.now();
    return { success: true, url: session.currentUrl };
  } catch (err: any) {
    return { success: false, url: session.currentUrl };
  }
}

export async function goForward(session: BrowserSession): Promise<{ success: boolean; url: string }> {
  try {
    await session.page.goForward();
    session.currentUrl = session.page.url();
    session.lastActivity = Date.now();
    return { success: true, url: session.currentUrl };
  } catch (err: any) {
    return { success: false, url: session.currentUrl };
  }
}

export async function reload(session: BrowserSession): Promise<{ success: boolean; url: string }> {
  try {
    await session.page.reload();
    session.currentUrl = session.page.url();
    session.lastActivity = Date.now();
    return { success: true, url: session.currentUrl };
  } catch (err: any) {
    return { success: false, url: session.currentUrl };
  }
}

// ============ INTERACTION ============

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  timeout?: number;
}

export async function click(session: BrowserSession, selector: string, options: ClickOptions = {}): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await session.page.click(selector, {
      button: options.button || 'left',
      clickCount: options.clickCount || 1,
      delay: options.delay,
      timeout: options.timeout || 30000
    });
    session.lastActivity = Date.now();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface TypeOptions {
  delay?: number;
  timeout?: number;
}

export async function type(session: BrowserSession, selector: string, text: string, options: TypeOptions = {}): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await session.page.type(selector, text, {
      delay: options.delay || 50,
      timeout: options.timeout || 30000
    });
    session.lastActivity = Date.now();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function fill(session: BrowserSession, selector: string, value: string, timeout = 30000): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await session.page.fill(selector, value, { timeout });
    session.lastActivity = Date.now();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function selectOption(session: BrowserSession, selector: string, value: string | string[], timeout = 30000): Promise<{
  success: boolean;
  selected: string[];
  error?: string;
}> {
  try {
    const selected = await session.page.selectOption(selector, value, { timeout });
    session.lastActivity = Date.now();
    return { success: true, selected };
  } catch (err: any) {
    return { success: false, selected: [], error: err.message };
  }
}

export interface ScrollOptions {
  x?: number;
  y?: number;
  selector?: string;
  timeout?: number;
}

export async function scroll(session: BrowserSession, options: ScrollOptions = {}): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    if (options.selector) {
      // Scroll element into view
      await session.page.locator(options.selector).scrollIntoViewIfNeeded({ timeout: options.timeout || 30000 });
    } else {
      // Scroll page by x, y
      await session.page.evaluate(({ x, y }) => {
        window.scrollBy(x || 0, y || 0);
      }, { x: options.x || 0, y: options.y || 0 });
    }
    session.lastActivity = Date.now();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function hover(session: BrowserSession, selector: string, timeout = 30000): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await session.page.hover(selector, { timeout });
    session.lastActivity = Date.now();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============ PAGE INFO ============

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
}

export async function screenshot(session: BrowserSession, options: ScreenshotOptions = {}): Promise<{
  success: boolean;
  data?: Buffer;
  error?: string;
}> {
  try {
    let buffer: Buffer;

    if (options.selector) {
      buffer = await session.page.locator(options.selector).screenshot({
        type: options.type || 'png',
        quality: options.type === 'jpeg' ? options.quality : undefined
      });
    } else {
      buffer = await session.page.screenshot({
        fullPage: options.fullPage ?? false,
        type: options.type || 'png',
        quality: options.type === 'jpeg' ? options.quality : undefined
      });
    }

    session.lastActivity = Date.now();
    return { success: true, data: buffer };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface GetLogsOptions {
  type?: 'console' | 'error' | 'network';
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
  since?: number;
  limit?: number;
  clear?: boolean;
}

export function getLogs(session: BrowserSession, options: GetLogsOptions = {}): LogEntry[] {
  let logs = [...session.logs];

  // Filter by type
  if (options.type) {
    logs = logs.filter(log => log.type === options.type);
  }

  // Filter by level (for console logs)
  if (options.level) {
    logs = logs.filter(log => log.level === options.level);
  }

  // Filter by timestamp
  if (options.since) {
    logs = logs.filter(log => log.timestamp >= options.since);
  }

  // Apply limit
  const limit = options.limit ?? 100;
  if (logs.length > limit) {
    logs = logs.slice(-limit);
  }

  // Clear logs if requested
  if (options.clear) {
    session.logs = [];
  }

  session.lastActivity = Date.now();
  return logs;
}

export async function getHtml(session: BrowserSession, selector?: string): Promise<{
  success: boolean;
  html?: string;
  error?: string;
}> {
  try {
    let html: string;
    if (selector) {
      html = await session.page.locator(selector).innerHTML();
    } else {
      html = await session.page.content();
    }
    session.lastActivity = Date.now();
    return { success: true, html };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function evaluate(session: BrowserSession, script: string): Promise<{
  success: boolean;
  result?: any;
  error?: string;
}> {
  try {
    const result = await session.page.evaluate(script);
    session.lastActivity = Date.now();
    return { success: true, result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface ElementInfo {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  visible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

export async function query(session: BrowserSession, selector: string, options: { limit?: number } = {}): Promise<{
  success: boolean;
  elements: ElementInfo[];
  count: number;
  error?: string;
}> {
  try {
    const limit = options.limit ?? 10;
    const locator = session.page.locator(selector);
    const count = await locator.count();

    const elements: ElementInfo[] = [];
    for (let i = 0; i < Math.min(count, limit); i++) {
      const el = locator.nth(i);
      const [tag, id, classes, text, visible, boundingBox] = await Promise.all([
        el.evaluate(e => e.tagName.toLowerCase()),
        el.evaluate(e => e.id || ''),
        el.evaluate(e => Array.from(e.classList)),
        el.evaluate(e => (e as HTMLElement).innerText?.slice(0, 200) || ''),
        el.isVisible(),
        el.boundingBox()
      ]);

      elements.push({ tag, id, classes, text, visible, boundingBox });
    }

    session.lastActivity = Date.now();
    return { success: true, elements, count };
  } catch (err: any) {
    return { success: false, elements: [], count: 0, error: err.message };
  }
}

// ============ WAITING ============

export interface WaitOptions {
  type: 'selector' | 'navigation' | 'timeout';
  selector?: string;
  timeout?: number;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

export async function wait(session: BrowserSession, options: WaitOptions): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const timeout = options.timeout || 30000;

    switch (options.type) {
      case 'selector':
        if (!options.selector) {
          return { success: false, error: 'Selector required for wait type "selector"' };
        }
        await session.page.waitForSelector(options.selector, {
          state: options.state || 'visible',
          timeout
        });
        break;

      case 'navigation':
        await session.page.waitForNavigation({ timeout });
        session.currentUrl = session.page.url();
        break;

      case 'timeout':
        await session.page.waitForTimeout(timeout);
        break;

      default:
        return { success: false, error: `Unknown wait type: ${options.type}` };
    }

    session.lastActivity = Date.now();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
