/**
 * Recorder Service
 *
 * Records user interactions with the browser and converts them to actions.
 */

import type { Page } from 'playwright';
import type { RecordedAction, RecordingSession } from './automation-types.js';
import { generateSelector } from './selector-generator.js';
import { getSession } from './browser-session-service.js';

// Active recording sessions
const recordingSessions = new Map<string, RecordingSession>();

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Start recording actions
 */
export async function startRecording(): Promise<RecordingSession> {
  const browserSession = getSession();
  if (!browserSession) {
    throw new Error('No active browser session');
  }

  // Stop any existing recording for this session
  const existing = Array.from(recordingSessions.values()).find(
    rs => rs.sessionId === browserSession.id && rs.status === 'recording'
  );
  if (existing) {
    await stopRecording(existing.id);
  }

  const session: RecordingSession = {
    id: generateId(),
    sessionId: browserSession.id,
    actions: [],
    startTime: Date.now(),
    status: 'recording'
  };

  recordingSessions.set(session.id, session);

  // Attach event listeners
  await attachRecordingListeners(browserSession.page, session);

  console.log(`[recorder] Started recording session: ${session.id}`);
  return session;
}

/**
 * Stop recording actions
 */
export async function stopRecording(recordingId: string): Promise<RecordingSession | null> {
  const session = recordingSessions.get(recordingId);
  if (!session) {
    return null;
  }

  session.status = 'stopped';
  session.endTime = Date.now();

  // Remove event listeners
  const browserSession = getSession();
  if (browserSession) {
    await removeRecordingListeners(browserSession.page);
  }

  console.log(`[recorder] Stopped recording session: ${session.id}`);
  return session;
}

/**
 * Get recording session
 */
export function getRecordingSession(recordingId: string): RecordingSession | null {
  return recordingSessions.get(recordingId) || null;
}

/**
 * Get all recording sessions
 */
export function getAllRecordingSessions(): RecordingSession[] {
  return Array.from(recordingSessions.values());
}

/**
 * Get active recording session
 */
export function getActiveRecording(): RecordingSession | null {
  return Array.from(recordingSessions.values()).find(
    rs => rs.status === 'recording'
  ) || null;
}

/**
 * Delete recording session
 */
export function deleteRecordingSession(recordingId: string): boolean {
  return recordingSessions.delete(recordingId);
}

/**
 * Clear all recording sessions
 */
export function clearRecordingSessions(): void {
  recordingSessions.clear();
}

/**
 * Add action to recording session
 */
function addAction(session: RecordingSession, action: Omit<RecordedAction, 'id' | 'timestamp'>): void {
  if (session.status !== 'recording') {
    return;
  }

  const recordedAction: RecordedAction = {
    ...action,
    id: generateId(),
    timestamp: Date.now()
  };

  session.actions.push(recordedAction);
}

/**
 * Attach recording event listeners to page
 */
async function attachRecordingListeners(page: Page, session: RecordingSession): Promise<void> {
  // Navigation events
  page.on('load', async () => {
    addAction(session, {
      type: 'navigation',
      url: page.url()
    });
  });

  // Click events
  await page.exposeFunction('__recordClick', async (selector: string, button: string) => {
    addAction(session, {
      type: 'click',
      selector,
      button: button as any
    });
  });

  // Input events
  await page.exposeFunction('__recordInput', async (selector: string, value: string) => {
    addAction(session, {
      type: 'fill',
      selector,
      value
    });
  });

  // Select events
  await page.exposeFunction('__recordSelect', async (selector: string, value: string) => {
    addAction(session, {
      type: 'select',
      selector,
      value
    });
  });

  // Inject recording script
  await page.addInitScript(() => {
    // Track last input to debounce
    let lastInputTarget: any = null;
    let lastInputTimer: any = null;

    // Sanitize CSS selector to prevent injection
    function sanitizeCSSSelector(str: string): string {
      // Escape special CSS characters per CSS spec
      return str.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, '\\$&');
    }

    // Click handler
    document.addEventListener('click', async (e: any) => {
      const target = e.target;
      if (!target) return;

      try {
        // Generate selector (simplified for init script)
        const selector = target.id
          ? `#${sanitizeCSSSelector(target.id)}`
          : target.className
          ? `${target.tagName.toLowerCase()}.${sanitizeCSSSelector(target.className.split(' ')[0])}`
          : target.tagName.toLowerCase();

        const button = e.button === 0 ? 'left' : e.button === 1 ? 'middle' : 'right';
        await (window as any).__recordClick(selector, button);
      } catch (err) {
        console.error('Recording error:', err);
      }
    }, true);

    // Input handler (debounced)
    document.addEventListener('input', async (e: any) => {
      const target = e.target;
      if (!target || !['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      lastInputTarget = target;

      // Clear previous timer
      if (lastInputTimer) {
        clearTimeout(lastInputTimer);
      }

      // Debounce input recording
      lastInputTimer = setTimeout(async () => {
        try {
          const selector = target.id
            ? `#${sanitizeCSSSelector(target.id)}`
            : target.name
            ? `[name="${sanitizeCSSSelector(target.name)}"]`
            : target.tagName.toLowerCase();

          const value = target.value;
          await (window as any).__recordInput(selector, value);
        } catch (err) {
          console.error('Recording error:', err);
        }
      }, 500);
    }, true);

    // Select handler
    document.addEventListener('change', async (e: any) => {
      const target = e.target;
      if (!target || target.tagName !== 'SELECT') return;

      try {
        const selector = target.id
          ? `#${sanitizeCSSSelector(target.id)}`
          : target.name
          ? `[name="${sanitizeCSSSelector(target.name)}"]`
          : 'select';

        const value = target.value;
        await (window as any).__recordSelect(selector, value);
      } catch (err) {
        console.error('Recording error:', err);
      }
    }, true);
  });
}

/**
 * Remove recording event listeners
 */
async function removeRecordingListeners(page: Page): Promise<void> {
  // Remove all listeners by removing exposed functions
  // Note: Playwright doesn't provide a way to remove exposed functions,
  // so we just stop adding actions to the session
}

/**
 * Add assertion to recording
 */
export function addAssertion(
  recordingId: string,
  assertionType: 'visible' | 'hidden' | 'text' | 'value' | 'count',
  selector: string,
  expected?: any
): boolean {
  const session = recordingSessions.get(recordingId);
  if (!session || session.status !== 'recording') {
    return false;
  }

  addAction(session, {
    type: 'assertion',
    assertionType,
    selector,
    expected
  });

  return true;
}

/**
 * Add wait to recording
 */
export function addWait(
  recordingId: string,
  waitType: 'selector' | 'navigation' | 'timeout',
  options: {
    selector?: string;
    timeout?: number;
    waitState?: 'attached' | 'detached' | 'visible' | 'hidden';
  } = {}
): boolean {
  const session = recordingSessions.get(recordingId);
  if (!session || session.status !== 'recording') {
    return false;
  }

  addAction(session, {
    type: 'wait',
    waitType,
    ...options
  });

  return true;
}
