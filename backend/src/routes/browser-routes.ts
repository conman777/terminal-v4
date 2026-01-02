/**
 * Browser Control Routes
 *
 * API endpoints for headless browser automation via Playwright.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  startSession,
  getSession,
  stopSession,
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
}
