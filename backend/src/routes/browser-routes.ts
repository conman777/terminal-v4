/**
 * Browser Control Routes
 *
 * API endpoints for headless browser automation via Playwright.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  startSession,
  getSession,
  getSessionById,
  getAllSessions,
  getAllSessionsStatus,
  switchSession,
  stopSession,
  stopSessionById,
  getSessionStatus
} from '../browser/browser-session-service.js';
import {
  goto,
  goBack,
  goForward,
  reload,
  click,
  type,
  fill,
  selectOption,
  scroll,
  hover,
  screenshot,
  getLogs,
  getHtml,
  evaluate,
  query,
  wait,
  GotoOptions,
  ClickOptions,
  TypeOptions,
  ScrollOptions,
  ScreenshotOptions,
  GetLogsOptions,
  WaitOptions
} from '../browser/browser-actions-service.js';
import {
  compareImages,
  validateDiffOptions,
  type DiffOptions
} from '../browser/visual-regression-service.js';
import {
  saveBaseline,
  getBaseline,
  listBaselines,
  deleteBaseline,
  baselineExists
} from '../storage/baseline-storage.js';
import {
  startRecording,
  stopRecording,
  getRecordingSession,
  getAllRecordingSessions,
  getActiveRecording,
  deleteRecordingSession,
  addAssertion,
  addWait
} from '../browser/recorder-service.js';
import { generateCode } from '../browser/code-generator.js';
import type { CodeGenerationOptions } from '../browser/automation-types.js';
import {
  getCookies,
  getCookie,
  setCookie,
  setCookies,
  deleteCookie,
  deleteCookies,
  clearCookies,
  exportCookies,
  importCookies,
  getCookieStats
} from '../browser/cookie-service.js';
import type { Cookie, CookieFilter } from '../browser/automation-types.js';
import {
  runTests,
  getTestRun,
  getTestJob,
  getAllTestRuns,
  cancelTestRun,
  registerStreamConnection,
  unregisterStreamConnection
} from '../browser/test-runner-service.js';
import {
  initializePool,
  shutdownPool,
  getPoolStats,
  isPoolReady
} from '../browser/worker-pool.js';

// Helper to check session exists
function requireSession(reply: FastifyReply): ReturnType<typeof getSession> {
  const session = getSession();
  if (!session) {
    reply.code(400).send({ error: 'No active browser session. Call POST /api/browser/start first.' });
    return null;
  }
  return session;
}

export async function registerBrowserRoutes(app: FastifyInstance): Promise<void> {

  // ============ SESSION MANAGEMENT ============

  /**
   * POST /api/browser/start
   * Start a new browser session
   */
  app.post('/api/browser/start', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const session = await startSession();
      return reply.send({
        success: true,
        sessionId: session.id,
        message: 'Browser session started'
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * DELETE /api/browser/stop
   * Stop the active browser session
   */
  app.delete('/api/browser/stop', async (request: FastifyRequest, reply: FastifyReply) => {
    const stopped = await stopSession();
    return reply.send({
      success: stopped,
      message: stopped ? 'Browser session stopped' : 'No active session'
    });
  });

  /**
   * GET /api/browser/status
   * Get the current session status
   */
  app.get('/api/browser/status', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(getSessionStatus());
  });

  // NOTE: Session management routes moved to browser-session-routes.ts
  // These routes are commented out to avoid conflicts with the new session manager

  /*
   * GET /api/browser/sessions - moved to browser-session-routes.ts
   * POST /api/browser/sessions - moved to browser-session-routes.ts
   * PUT /api/browser/sessions/:id/switch - use /api/browser/sessions/:id/activate in browser-session-routes.ts
   * DELETE /api/browser/sessions/:id - moved to browser-session-routes.ts
   */

  // ============ NAVIGATION ============

  /**
   * POST /api/browser/goto
   * Navigate to a URL
   */
  app.post('/api/browser/goto', async (request: FastifyRequest<{
    Body: { url: string } & GotoOptions
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { url, ...options } = request.body;
    if (!url) {
      return reply.code(400).send({ error: 'url is required' });
    }

    const result = await goto(session, url, options);
    return reply.send(result);
  });

  /**
   * POST /api/browser/back
   * Navigate back
   */
  app.post('/api/browser/back', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const result = await goBack(session);
    return reply.send(result);
  });

  /**
   * POST /api/browser/forward
   * Navigate forward
   */
  app.post('/api/browser/forward', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const result = await goForward(session);
    return reply.send(result);
  });

  /**
   * POST /api/browser/reload
   * Reload the page
   */
  app.post('/api/browser/reload', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const result = await reload(session);
    return reply.send(result);
  });

  // ============ INTERACTION ============

  /**
   * POST /api/browser/click
   * Click an element
   */
  app.post('/api/browser/click', async (request: FastifyRequest<{
    Body: { selector: string } & ClickOptions
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { selector, ...options } = request.body;
    if (!selector) {
      return reply.code(400).send({ error: 'selector is required' });
    }

    const result = await click(session, selector, options);
    return reply.send(result);
  });

  /**
   * POST /api/browser/type
   * Type text into an element
   */
  app.post('/api/browser/type', async (request: FastifyRequest<{
    Body: { selector: string; text: string } & TypeOptions
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { selector, text, ...options } = request.body;
    if (!selector || text === undefined) {
      return reply.code(400).send({ error: 'selector and text are required' });
    }

    const result = await type(session, selector, text, options);
    return reply.send(result);
  });

  /**
   * POST /api/browser/fill
   * Fill an input field
   */
  app.post('/api/browser/fill', async (request: FastifyRequest<{
    Body: { selector: string; value: string; timeout?: number }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { selector, value, timeout } = request.body;
    if (!selector || value === undefined) {
      return reply.code(400).send({ error: 'selector and value are required' });
    }

    const result = await fill(session, selector, value, timeout);
    return reply.send(result);
  });

  /**
   * POST /api/browser/select
   * Select a dropdown option
   */
  app.post('/api/browser/select', async (request: FastifyRequest<{
    Body: { selector: string; value: string | string[]; timeout?: number }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { selector, value, timeout } = request.body;
    if (!selector || value === undefined) {
      return reply.code(400).send({ error: 'selector and value are required' });
    }

    const result = await selectOption(session, selector, value, timeout);
    return reply.send(result);
  });

  /**
   * POST /api/browser/scroll
   * Scroll the page or an element
   */
  app.post('/api/browser/scroll', async (request: FastifyRequest<{
    Body: ScrollOptions
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const result = await scroll(session, request.body);
    return reply.send(result);
  });

  /**
   * POST /api/browser/hover
   * Hover over an element
   */
  app.post('/api/browser/hover', async (request: FastifyRequest<{
    Body: { selector: string; timeout?: number }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { selector, timeout } = request.body;
    if (!selector) {
      return reply.code(400).send({ error: 'selector is required' });
    }

    const result = await hover(session, selector, timeout);
    return reply.send(result);
  });

  // ============ PAGE INFO ============

  /**
   * GET /api/browser/screenshot
   * Capture a screenshot
   */
  app.get('/api/browser/screenshot', async (request: FastifyRequest<{
    Querystring: {
      fullPage?: string;
      selector?: string;
      type?: 'png' | 'jpeg';
      quality?: string;
      base64?: string;
    }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const options: ScreenshotOptions = {
      fullPage: request.query.fullPage === 'true',
      selector: request.query.selector,
      type: request.query.type || 'png',
      quality: request.query.quality ? parseInt(request.query.quality, 10) : undefined
    };

    const result = await screenshot(session, options);

    if (!result.success || !result.data) {
      return reply.code(500).send({ error: result.error || 'Screenshot failed' });
    }

    // Return as base64 JSON or binary image
    if (request.query.base64 === 'true') {
      return reply.send({
        success: true,
        data: result.data.toString('base64'),
        type: options.type
      });
    }

    reply.header('Content-Type', `image/${options.type || 'png'}`);
    return reply.send(result.data);
  });

  /**
   * GET /api/browser/logs
   * Get captured logs
   */
  app.get('/api/browser/logs', async (request: FastifyRequest<{
    Querystring: {
      type?: 'console' | 'error' | 'network';
      level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
      since?: string;
      limit?: string;
      clear?: string;
    }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const options: GetLogsOptions = {
      type: request.query.type,
      level: request.query.level,
      since: request.query.since ? parseInt(request.query.since, 10) : undefined,
      limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined,
      clear: request.query.clear === 'true'
    };

    const logs = getLogs(session, options);
    return reply.send({
      count: logs.length,
      logs
    });
  });

  /**
   * GET /api/browser/html
   * Get page HTML
   */
  app.get('/api/browser/html', async (request: FastifyRequest<{
    Querystring: { selector?: string }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const result = await getHtml(session, request.query.selector);
    return reply.send(result);
  });

  /**
   * POST /api/browser/evaluate
   * Run JavaScript in the page
   */
  app.post('/api/browser/evaluate', async (request: FastifyRequest<{
    Body: { script: string }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { script } = request.body;
    if (!script) {
      return reply.code(400).send({ error: 'script is required' });
    }

    const result = await evaluate(session, script);
    return reply.send(result);
  });

  /**
   * POST /api/browser/query
   * Query DOM elements
   */
  app.post('/api/browser/query', async (request: FastifyRequest<{
    Body: { selector: string; limit?: number }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { selector, limit } = request.body;
    if (!selector) {
      return reply.code(400).send({ error: 'selector is required' });
    }

    const result = await query(session, selector, { limit });
    return reply.send(result);
  });

  // ============ WAITING ============

  /**
   * POST /api/browser/wait
   * Wait for selector, navigation, or timeout
   */
  app.post('/api/browser/wait', async (request: FastifyRequest<{
    Body: WaitOptions
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const result = await wait(session, request.body);
    return reply.send(result);
  });

  // ============ VISUAL REGRESSION TESTING ============

  /**
   * POST /api/browser/visual-test/baseline
   * Save a screenshot as a baseline for visual regression testing
   */
  app.post('/api/browser/visual-test/baseline', async (request: FastifyRequest<{
    Body: {
      name: string;
      url?: string;
      devicePreset?: string;
      fullPage?: boolean;
      selector?: string;
    }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { name, url, devicePreset, fullPage, selector } = request.body;

    if (!name) {
      return reply.code(400).send({ error: 'name is required' });
    }

    try {
      // Take screenshot
      const screenshotResult = await screenshot(session, {
        fullPage: fullPage || false,
        selector,
        type: 'png'
      });

      if (!screenshotResult.success || !screenshotResult.data) {
        return reply.code(500).send({ error: screenshotResult.error || 'Screenshot failed' });
      }

      // Save as baseline
      const baseline = await saveBaseline(name, screenshotResult.data as Buffer, {
        url,
        devicePreset
      });

      return reply.send({
        success: true,
        baseline: {
          name: baseline.name,
          width: baseline.width,
          height: baseline.height,
          size: baseline.size,
          createdAt: baseline.createdAt,
          updatedAt: baseline.updatedAt,
          url: baseline.url,
          devicePreset: baseline.devicePreset
        }
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /api/browser/visual-test/compare
   * Compare current screenshot with baseline
   */
  app.post('/api/browser/visual-test/compare', async (request: FastifyRequest<{
    Body: {
      name: string;
      fullPage?: boolean;
      selector?: string;
    } & DiffOptions
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { name, fullPage, selector, ...diffOptions } = request.body;

    if (!name) {
      return reply.code(400).send({ error: 'name is required' });
    }

    // Validate diff options
    const validation = validateDiffOptions(diffOptions);
    if (!validation.valid) {
      return reply.code(400).send({ error: validation.error });
    }

    try {
      // Get baseline
      const baseline = await getBaseline(name);
      if (!baseline) {
        return reply.code(404).send({ error: `Baseline '${name}' not found` });
      }

      // Take current screenshot
      const screenshotResult = await screenshot(session, {
        fullPage: fullPage || false,
        selector,
        type: 'png'
      });

      if (!screenshotResult.success || !screenshotResult.data) {
        return reply.code(500).send({ error: screenshotResult.error || 'Screenshot failed' });
      }

      // Compare
      const diffResult = await compareImages(
        baseline.image,
        screenshotResult.data as Buffer,
        diffOptions
      );

      return reply.send({
        success: true,
        comparison: {
          name,
          matches: diffResult.matches,
          pixelsDifferent: diffResult.pixelsDifferent,
          totalPixels: diffResult.totalPixels,
          percentDifferent: diffResult.percentDifferent,
          width: diffResult.width,
          height: diffResult.height
        },
        diffImage: diffResult.diffImage.toString('base64')
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/browser/visual-test/baselines
   * List all saved baselines
   */
  app.get('/api/browser/visual-test/baselines', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const baselines = await listBaselines();

      return reply.send({
        count: baselines.length,
        baselines: baselines.map(b => ({
          name: b.name,
          width: b.width,
          height: b.height,
          size: b.size,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
          url: b.url,
          devicePreset: b.devicePreset
        }))
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/browser/visual-test/baseline/:name
   * Get a specific baseline image
   */
  app.get('/api/browser/visual-test/baseline/:name', async (request: FastifyRequest<{
    Params: { name: string }
  }>, reply: FastifyReply) => {
    const { name } = request.params;

    try {
      const baseline = await getBaseline(name);
      if (!baseline) {
        return reply.code(404).send({ error: `Baseline '${name}' not found` });
      }

      reply.header('Content-Type', 'image/png');
      return reply.send(baseline.image);
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * DELETE /api/browser/visual-test/baseline/:name
   * Delete a baseline
   */
  app.delete('/api/browser/visual-test/baseline/:name', async (request: FastifyRequest<{
    Params: { name: string }
  }>, reply: FastifyReply) => {
    const { name } = request.params;

    try {
      const deleted = await deleteBaseline(name);
      if (!deleted) {
        return reply.code(404).send({ error: `Baseline '${name}' not found` });
      }

      return reply.send({
        success: true,
        message: `Baseline '${name}' deleted`
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ============ ACTION RECORDING ============

  /**
   * POST /api/browser/recorder/start
   * Start recording browser actions
   */
  app.post('/api/browser/recorder/start', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const session = await startRecording();
      return reply.send({
        success: true,
        recording: {
          id: session.id,
          sessionId: session.sessionId,
          status: session.status,
          startTime: session.startTime
        }
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /api/browser/recorder/stop
   * Stop recording browser actions
   */
  app.post('/api/browser/recorder/stop', async (request: FastifyRequest<{
    Body: { recordingId: string }
  }>, reply: FastifyReply) => {
    const { recordingId } = request.body;

    if (!recordingId) {
      return reply.code(400).send({ error: 'recordingId is required' });
    }

    const session = await stopRecording(recordingId);

    if (!session) {
      return reply.code(404).send({ error: 'Recording session not found' });
    }

    return reply.send({
      success: true,
      recording: {
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        startTime: session.startTime,
        endTime: session.endTime,
        actionCount: session.actions.length
      }
    });
  });

  /**
   * POST /api/browser/recorder/generate
   * Generate test code from recorded actions
   */
  app.post('/api/browser/recorder/generate', async (request: FastifyRequest<{
    Body: { recordingId: string } & CodeGenerationOptions
  }>, reply: FastifyReply) => {
    const { recordingId, ...options } = request.body;

    if (!recordingId) {
      return reply.code(400).send({ error: 'recordingId is required' });
    }

    const session = getRecordingSession(recordingId);
    if (!session) {
      return reply.code(404).send({ error: 'Recording session not found' });
    }

    try {
      const generated = generateCode(session.actions, options);
      return reply.send({
        success: true,
        code: generated
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/browser/recorder/actions/:sessionId
   * Get actions from a recording session
   */
  app.get('/api/browser/recorder/actions/:sessionId', async (request: FastifyRequest<{
    Params: { sessionId: string }
  }>, reply: FastifyReply) => {
    const { sessionId } = request.params;

    const session = getRecordingSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Recording session not found' });
    }

    return reply.send({
      recording: {
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        startTime: session.startTime,
        endTime: session.endTime,
        actions: session.actions
      }
    });
  });

  /**
   * GET /api/browser/recorder/sessions
   * Get all recording sessions
   */
  app.get('/api/browser/recorder/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessions = getAllRecordingSessions();
    return reply.send({
      count: sessions.length,
      sessions: sessions.map(s => ({
        id: s.id,
        sessionId: s.sessionId,
        status: s.status,
        startTime: s.startTime,
        endTime: s.endTime,
        actionCount: s.actions.length
      }))
    });
  });

  /**
   * GET /api/browser/recorder/active
   * Get active recording session
   */
  app.get('/api/browser/recorder/active', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = getActiveRecording();
    if (!session) {
      return reply.send({ active: false });
    }

    return reply.send({
      active: true,
      recording: {
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        startTime: session.startTime,
        actionCount: session.actions.length
      }
    });
  });

  /**
   * DELETE /api/browser/recorder/:recordingId
   * Delete a recording session
   */
  app.delete('/api/browser/recorder/:recordingId', async (request: FastifyRequest<{
    Params: { recordingId: string }
  }>, reply: FastifyReply) => {
    const { recordingId } = request.params;

    const deleted = deleteRecordingSession(recordingId);
    if (!deleted) {
      return reply.code(404).send({ error: 'Recording session not found' });
    }

    return reply.send({
      success: true,
      message: 'Recording session deleted'
    });
  });

  /**
   * POST /api/browser/recorder/assertion
   * Add an assertion to the active recording
   */
  app.post('/api/browser/recorder/assertion', async (request: FastifyRequest<{
    Body: {
      recordingId: string;
      type: 'visible' | 'hidden' | 'text' | 'value' | 'count';
      selector: string;
      expected?: any;
    }
  }>, reply: FastifyReply) => {
    const { recordingId, type, selector, expected } = request.body;

    if (!recordingId || !type || !selector) {
      return reply.code(400).send({ error: 'recordingId, type, and selector are required' });
    }

    const success = addAssertion(recordingId, type, selector, expected);
    if (!success) {
      return reply.code(400).send({ error: 'Recording session not found or not active' });
    }

    return reply.send({ success: true });
  });

  /**
   * POST /api/browser/recorder/wait
   * Add a wait to the active recording
   */
  app.post('/api/browser/recorder/wait', async (request: FastifyRequest<{
    Body: {
      recordingId: string;
      type: 'selector' | 'navigation' | 'timeout';
      selector?: string;
      timeout?: number;
      state?: 'attached' | 'detached' | 'visible' | 'hidden';
    }
  }>, reply: FastifyReply) => {
    const { recordingId, type, selector, timeout, state } = request.body;

    if (!recordingId || !type) {
      return reply.code(400).send({ error: 'recordingId and type are required' });
    }

    const success = addWait(recordingId, type, { selector, timeout, waitState: state });
    if (!success) {
      return reply.code(400).send({ error: 'Recording session not found or not active' });
    }

    return reply.send({ success: true });
  });

  // ============ COOKIE MANAGEMENT ============

  /**
   * GET /api/browser/cookies
   * Get all cookies or filtered cookies
   */
  app.get('/api/browser/cookies', async (request: FastifyRequest<{
    Querystring: CookieFilter
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    try {
      const cookies = await getCookies(session.page, request.query);
      return reply.send({
        count: cookies.length,
        cookies
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/browser/cookies/:name
   * Get a specific cookie by name
   */
  app.get('/api/browser/cookies/:name', async (request: FastifyRequest<{
    Params: { name: string }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { name } = request.params;

    try {
      const cookie = await getCookie(session.page, name);
      if (!cookie) {
        return reply.code(404).send({ error: 'Cookie not found' });
      }

      return reply.send({ cookie });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /api/browser/cookies
   * Set a cookie
   */
  app.post('/api/browser/cookies', async (request: FastifyRequest<{
    Body: { cookie: Cookie }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { cookie } = request.body;

    if (!cookie || !cookie.name || !cookie.value || !cookie.domain || !cookie.path) {
      return reply.code(400).send({ error: 'Invalid cookie: name, value, domain, and path are required' });
    }

    try {
      await setCookie(session.page, cookie);
      return reply.send({ success: true });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /api/browser/cookies/bulk
   * Set multiple cookies
   */
  app.post('/api/browser/cookies/bulk', async (request: FastifyRequest<{
    Body: { cookies: Cookie[] }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { cookies } = request.body;

    if (!Array.isArray(cookies)) {
      return reply.code(400).send({ error: 'cookies must be an array' });
    }

    try {
      await setCookies(session.page, cookies);
      return reply.send({
        success: true,
        count: cookies.length
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * DELETE /api/browser/cookies/:name
   * Delete a cookie by name
   */
  app.delete('/api/browser/cookies/:name', async (request: FastifyRequest<{
    Params: { name: string }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { name } = request.params;

    try {
      const deleted = await deleteCookie(session.page, name);
      if (!deleted) {
        return reply.code(404).send({ error: 'Cookie not found' });
      }

      return reply.send({
        success: true,
        message: 'Cookie deleted'
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * DELETE /api/browser/cookies
   * Delete multiple cookies or clear all
   */
  app.delete('/api/browser/cookies', async (request: FastifyRequest<{
    Body: { names?: string[] }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { names } = request.body;

    try {
      if (names && Array.isArray(names) && names.length > 0) {
        const deletedCount = await deleteCookies(session.page, names);
        return reply.send({
          success: true,
          deletedCount
        });
      } else {
        await clearCookies(session.page);
        return reply.send({
          success: true,
          message: 'All cookies cleared'
        });
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/browser/cookies/export
   * Export cookies as JSON
   */
  app.get('/api/browser/cookies/export', async (request: FastifyRequest<{
    Querystring: CookieFilter
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    try {
      const json = await exportCookies(session.page, request.query);
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', 'attachment; filename="cookies.json"');
      return reply.send(json);
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /api/browser/cookies/import
   * Import cookies from JSON
   */
  app.post('/api/browser/cookies/import', async (request: FastifyRequest<{
    Body: { json: string }
  }>, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    const { json } = request.body;

    if (!json) {
      return reply.code(400).send({ error: 'json is required' });
    }

    try {
      const count = await importCookies(session.page, json);
      return reply.send({
        success: true,
        imported: count
      });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /**
   * GET /api/browser/cookies/stats
   * Get cookie statistics
   */
  app.get('/api/browser/cookies/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = requireSession(reply);
    if (!session) return;

    try {
      const stats = await getCookieStats(session.page);
      return reply.send(stats);
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ============ TEST RUNNER ============

  /**
   * POST /api/browser/tests/run
   * Run tests in parallel
   */
  app.post('/api/browser/tests/run', async (request: FastifyRequest<{
    Body: {
      tests: Array<{
        name: string;
        code: string;
        framework: 'playwright' | 'puppeteer' | 'selenium';
      }>;
      maxRetries?: number;
      captureScreenshotOnFailure?: boolean;
      concurrency?: number;
    }
  }>, reply: FastifyReply) => {
    const { tests, maxRetries, captureScreenshotOnFailure, concurrency } = request.body;

    if (!tests || !Array.isArray(tests) || tests.length === 0) {
      return reply.code(400).send({ error: 'tests array is required and must not be empty' });
    }

    try {
      const run = await runTests(tests, { maxRetries, captureScreenshotOnFailure, concurrency });
      return reply.send({
        success: true,
        run: {
          id: run.id,
          status: run.status,
          summary: run.summary,
          startTime: run.startTime,
          endTime: run.endTime
        }
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/browser/tests/status/:runId
   * Get test run status
   */
  app.get('/api/browser/tests/status/:runId', async (request: FastifyRequest<{
    Params: { runId: string }
  }>, reply: FastifyReply) => {
    const { runId } = request.params;

    const run = getTestRun(runId);
    if (!run) {
      return reply.code(404).send({ error: 'Test run not found' });
    }

    return reply.send({
      run: {
        id: run.id,
        status: run.status,
        summary: run.summary,
        startTime: run.startTime,
        endTime: run.endTime,
        jobs: run.jobs.map(j => ({
          id: j.id,
          name: j.name,
          status: j.status,
          startTime: j.startTime,
          endTime: j.endTime,
          duration: j.duration,
          error: j.error
        }))
      }
    });
  });

  /**
   * GET /api/browser/tests/result/:jobId
   * Get test job result
   */
  app.get('/api/browser/tests/result/:jobId', async (request: FastifyRequest<{
    Params: { jobId: string }
  }>, reply: FastifyReply) => {
    const { jobId } = request.params;

    const job = getTestJob(jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Test job not found' });
    }

    return reply.send({
      job: {
        id: job.id,
        name: job.name,
        framework: job.framework,
        status: job.status,
        startTime: job.startTime,
        endTime: job.endTime,
        duration: job.duration,
        error: job.error,
        logs: job.logs,
        screenshot: job.screenshot ? job.screenshot.toString('base64') : undefined
      }
    });
  });

  /**
   * GET /api/browser/tests/runs
   * Get all test runs
   */
  app.get('/api/browser/tests/runs', async (request: FastifyRequest, reply: FastifyReply) => {
    const runs = getAllTestRuns();
    return reply.send({
      count: runs.length,
      runs: runs.map(r => ({
        id: r.id,
        status: r.status,
        summary: r.summary,
        startTime: r.startTime,
        endTime: r.endTime
      }))
    });
  });

  /**
   * POST /api/browser/tests/cancel/:runId
   * Cancel a test run
   */
  app.post('/api/browser/tests/cancel/:runId', async (request: FastifyRequest<{
    Params: { runId: string }
  }>, reply: FastifyReply) => {
    const { runId } = request.params;

    const cancelled = cancelTestRun(runId);
    if (!cancelled) {
      return reply.code(400).send({ error: 'Test run not found or not running' });
    }

    return reply.send({
      success: true,
      message: 'Test run cancelled'
    });
  });

  /**
   * GET /api/browser/worker-pool/stats
   * Get worker pool statistics
   */
  app.get('/api/browser/worker-pool/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const stats = getPoolStats();
    return reply.send(stats);
  });

  /**
   * POST /api/browser/worker-pool/init
   * Initialize worker pool
   */
  app.post('/api/browser/worker-pool/init', async (request: FastifyRequest<{
    Body: { maxWorkers?: number }
  }>, reply: FastifyReply) => {
    const { maxWorkers } = request.body;

    try {
      await initializePool(maxWorkers);
      return reply.send({
        success: true,
        message: 'Worker pool initialized'
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * POST /api/browser/worker-pool/shutdown
   * Shutdown worker pool
   */
  app.post('/api/browser/worker-pool/shutdown', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await shutdownPool();
      return reply.send({
        success: true,
        message: 'Worker pool shutdown'
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * WebSocket /api/browser/tests/stream
   * Stream test run updates via WebSocket
   */
  app.get('/api/browser/tests/stream', { websocket: true }, (connection, request) => {
    const runId = (request.query as any).runId;

    if (!runId) {
      connection.socket.close(1008, 'runId query parameter required');
      return;
    }

    registerStreamConnection(runId, connection.socket);

    connection.socket.on('close', () => {
      unregisterStreamConnection(runId);
    });

    connection.socket.send(JSON.stringify({ type: 'connected', runId }));
  });
}
