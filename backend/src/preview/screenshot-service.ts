import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { promises as fs } from 'fs';
import { join } from 'path';

const SCREENSHOT_DIR = '/tmp/preview-screenshots';
const RECORDING_DIR = '/tmp/preview-recordings';

let browserInstance: Browser | null = null;

interface ContextEntry {
  context: BrowserContext;
  lastUsed: number;
}

let browserContexts: Map<string, ContextEntry> = new Map();
let recordingPages: Map<string, { page: Page; context: BrowserContext; outputPath: string }> = new Map();

const MAX_CONTEXTS = 10;
const CONTEXT_TTL = 5 * 60 * 1000; // 5 minutes

// Ensure screenshot directories exist
async function ensureDirectories(): Promise<void> {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await fs.mkdir(RECORDING_DIR, { recursive: true });
}

// Get or create browser instance
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browserInstance;
}

// Get or create browser context for a URL
async function getContext(url: string): Promise<BrowserContext> {
  const contextKey = new URL(url).origin;
  const now = Date.now();

  // Cleanup old contexts first
  for (const [key, entry] of browserContexts.entries()) {
    if (now - entry.lastUsed > CONTEXT_TTL) {
      try {
        await entry.context.close();
      } catch (error) {
        console.error(`Failed to close old context ${key}:`, error);
      }
      browserContexts.delete(key);
    }
  }

  // Enforce max limit
  if (browserContexts.size >= MAX_CONTEXTS && !browserContexts.has(contextKey)) {
    // Remove oldest context
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, entry] of browserContexts.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = browserContexts.get(oldestKey);
      if (entry) {
        try {
          await entry.context.close();
        } catch (error) {
          console.error(`Failed to close oldest context ${oldestKey}:`, error);
        }
        browserContexts.delete(oldestKey);
      }
    }
  }

  // Get or create context
  let entry = browserContexts.get(contextKey);
  if (!entry) {
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    entry = { context, lastUsed: now };
    browserContexts.set(contextKey, entry);
  } else {
    entry.lastUsed = now;
  }

  return entry.context;
}

interface ScreenshotOptions {
  url: string;
  selector?: string;
  fullPage?: boolean;
  width?: number;
  height?: number;
}

interface ScreenshotResult {
  path: string;
  buffer: Buffer;
  width: number;
  height: number;
  timestamp: number;
}

export async function takeScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
  await ensureDirectories();

  const context = await getContext(options.url);
  const page = await context.newPage();

  try {
    // Set viewport if specified
    if (options.width && options.height) {
      await page.setViewportSize({ width: options.width, height: options.height });
    }

    // Navigate to URL
    await page.goto(options.url, { waitUntil: 'networkidle', timeout: 30000 });

    // Generate filename
    const timestamp = Date.now();
    const filename = `screenshot-${timestamp}.png`;
    const filepath = join(SCREENSHOT_DIR, filename);

    let screenshotBuffer: Buffer;
    let screenshotInfo: { width: number; height: number };

    if (options.selector) {
      // Screenshot specific element
      const element = await page.locator(options.selector).first();
      await element.waitFor({ state: 'visible', timeout: 10000 });
      const buffer = await element.screenshot({ type: 'png' });
      screenshotBuffer = buffer;

      // Get element dimensions
      const box = await element.boundingBox();
      screenshotInfo = {
        width: box?.width || 0,
        height: box?.height || 0
      };
    } else {
      // Full page or viewport screenshot
      screenshotBuffer = await page.screenshot({
        type: 'png',
        fullPage: options.fullPage || false
      });

      const viewport = page.viewportSize();
      screenshotInfo = {
        width: viewport?.width || 1280,
        height: viewport?.height || 720
      };
    }

    // Save to file
    await fs.writeFile(filepath, screenshotBuffer);

    return {
      path: filepath,
      buffer: screenshotBuffer,
      width: screenshotInfo.width,
      height: screenshotInfo.height,
      timestamp
    };
  } finally {
    await page.close();
  }
}

interface RecordingStartOptions {
  url: string;
  width?: number;
  height?: number;
}

interface RecordingStartResult {
  recordingId: string;
  started: number;
}

export async function startRecording(options: RecordingStartOptions): Promise<RecordingStartResult> {
  await ensureDirectories();

  const recordingId = `recording-${Date.now()}`;
  const outputPath = join(RECORDING_DIR, `${recordingId}.webm`);

  const context = await getContext(options.url);
  const page = await context.newPage();

  // Set viewport if specified
  if (options.width && options.height) {
    await page.setViewportSize({ width: options.width, height: options.height });
  }

  // Start video recording
  await context.tracing.start({
    screenshots: true,
    snapshots: true
  });

  // Navigate to URL
  await page.goto(options.url, { waitUntil: 'networkidle', timeout: 30000 });

  // Store recording info
  recordingPages.set(recordingId, {
    page,
    context,
    outputPath
  });

  return {
    recordingId,
    started: Date.now()
  };
}

interface RecordingStopResult {
  path: string;
  duration: number;
}

export async function stopRecording(recordingId: string): Promise<RecordingStopResult | null> {
  const recording = recordingPages.get(recordingId);
  if (!recording) {
    return null;
  }

  const startTime = parseInt(recordingId.split('-')[1], 10);
  const duration = Date.now() - startTime;

  try {
    // Stop tracing and save
    await recording.context.tracing.stop({ path: recording.outputPath });
    await recording.page.close();

    recordingPages.delete(recordingId);

    return {
      path: recording.outputPath,
      duration
    };
  } catch (error) {
    recordingPages.delete(recordingId);
    throw error;
  }
}

// Cleanup function to close browser and contexts
export async function cleanup(): Promise<void> {
  // Stop all active recordings
  for (const [recordingId] of recordingPages) {
    try {
      await stopRecording(recordingId);
    } catch (error) {
      console.error(`Failed to stop recording ${recordingId}:`, error);
    }
  }

  // Close all contexts
  for (const [, entry] of browserContexts) {
    try {
      await entry.context.close();
    } catch (error) {
      console.error('Failed to close context:', error);
    }
  }
  browserContexts.clear();

  // Close browser
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (error) {
      console.error('Failed to close browser:', error);
    }
    browserInstance = null;
  }
}

// List screenshots in directory
export async function listScreenshots(): Promise<Array<{ filename: string; size: number; created: number }>> {
  await ensureDirectories();

  try {
    const files = await fs.readdir(SCREENSHOT_DIR);
    const screenshots = await Promise.all(
      files
        .filter(f => f.endsWith('.png'))
        .map(async (filename) => {
          const filepath = join(SCREENSHOT_DIR, filename);
          const stats = await fs.stat(filepath);
          return {
            filename,
            size: stats.size,
            created: stats.mtimeMs
          };
        })
    );

    // Sort by creation time, newest first
    return screenshots.sort((a, b) => b.created - a.created);
  } catch (error) {
    return [];
  }
}

// Delete screenshot
export async function deleteScreenshot(filename: string): Promise<boolean> {
  try {
    const filepath = join(SCREENSHOT_DIR, filename);
    await fs.unlink(filepath);
    return true;
  } catch (error) {
    return false;
  }
}

// Get screenshot buffer
export async function getScreenshot(filename: string): Promise<Buffer | null> {
  try {
    const filepath = join(SCREENSHOT_DIR, filename);
    return await fs.readFile(filepath);
  } catch (error) {
    return null;
  }
}
