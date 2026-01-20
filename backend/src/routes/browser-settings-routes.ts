/**
 * Browser Settings Routes
 *
 * API endpoints for managing browser session settings
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getBrowserSettings,
  updateBrowserSettings,
  resetBrowserSettings,
  getDefaultBrowserSettings,
  type BrowserSettings
} from '../settings/browser-settings-service.js';

export async function registerBrowserSettingsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/settings/browser
   * Get current browser settings
   */
  app.get('/api/settings/browser', async (request: FastifyRequest, reply: FastifyReply) => {
    const settings = getBrowserSettings();
    const defaults = getDefaultBrowserSettings();

    return reply.send({
      settings,
      defaults
    });
  });

  /**
   * PUT /api/settings/browser
   * Update browser settings
   */
  app.put<{
    Body: Partial<BrowserSettings>;
  }>('/api/settings/browser', async (request: FastifyRequest<{
    Body: Partial<BrowserSettings>;
  }>, reply: FastifyReply) => {
    try {
      const updates = request.body;
      const settings = updateBrowserSettings(updates);

      return reply.send({
        success: true,
        settings
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({
        error: 'Invalid settings',
        message
      });
    }
  });

  /**
   * POST /api/settings/browser/reset
   * Reset browser settings to defaults
   */
  app.post('/api/settings/browser/reset', async (request: FastifyRequest, reply: FastifyReply) => {
    const settings = resetBrowserSettings();

    return reply.send({
      success: true,
      settings
    });
  });
}
