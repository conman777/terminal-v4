import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  takeScreenshot,
  startRecording,
  stopRecording,
  listScreenshots,
  deleteScreenshot,
  getScreenshot
} from '../preview/screenshot-service';

const ScreenshotRequestSchema = z.object({
  url: z.string().url(),
  selector: z.string().optional(),
  fullPage: z.boolean().optional().default(false),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional()
});

const RecordingStartRequestSchema = z.object({
  url: z.string().url(),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional()
});

export async function registerScreenshotRoutes(app: FastifyInstance): Promise<void> {
  // Take screenshot of preview URL
  app.post<{
    Params: { port: string };
    Body: { selector?: string; fullPage?: boolean; width?: number; height?: number };
  }>('/api/preview/:port/screenshot', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }

    try {
      // Construct preview URL
      const protocol = request.protocol;
      const host = request.hostname;
      const previewUrl = `${protocol}://preview-${port}.${host.replace(/^preview-\d+\./, '')}`;

      // Validate request body
      const validation = ScreenshotRequestSchema.safeParse({
        url: previewUrl,
        ...request.body
      });

      if (!validation.success) {
        reply.code(400).send({ error: 'Invalid request', details: validation.error.issues });
        return;
      }

      const result = await takeScreenshot(validation.data);

      reply.send({
        success: true,
        filename: result.path.split('/').pop(),
        width: result.width,
        height: result.height,
        timestamp: result.timestamp
      });
    } catch (error) {
      console.error('Screenshot error:', error);
      reply.code(500).send({
        error: 'Failed to take screenshot',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Take screenshot of specific element
  app.post<{
    Params: { port: string };
    Body: { selector: string; width?: number; height?: number };
  }>('/api/preview/:port/screenshot/element', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }

    if (!request.body.selector) {
      reply.code(400).send({ error: 'Missing required field: selector' });
      return;
    }

    try {
      const protocol = request.protocol;
      const host = request.hostname;
      const previewUrl = `${protocol}://preview-${port}.${host.replace(/^preview-\d+\./, '')}`;

      const validation = ScreenshotRequestSchema.safeParse({
        url: previewUrl,
        ...request.body
      });

      if (!validation.success) {
        reply.code(400).send({ error: 'Invalid request', details: validation.error.issues });
        return;
      }

      const result = await takeScreenshot(validation.data);

      reply.send({
        success: true,
        filename: result.path.split('/').pop(),
        width: result.width,
        height: result.height,
        timestamp: result.timestamp
      });
    } catch (error) {
      console.error('Element screenshot error:', error);
      reply.code(500).send({
        error: 'Failed to take element screenshot',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Start recording
  app.post<{
    Params: { port: string };
    Body: { width?: number; height?: number };
  }>('/api/preview/:port/recording/start', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }

    try {
      const protocol = request.protocol;
      const host = request.hostname;
      const previewUrl = `${protocol}://preview-${port}.${host.replace(/^preview-\d+\./, '')}`;

      const validation = RecordingStartRequestSchema.safeParse({
        url: previewUrl,
        ...request.body
      });

      if (!validation.success) {
        reply.code(400).send({ error: 'Invalid request', details: validation.error.issues });
        return;
      }

      const result = await startRecording(validation.data);

      reply.send({
        success: true,
        recordingId: result.recordingId,
        started: result.started
      });
    } catch (error) {
      console.error('Recording start error:', error);
      reply.code(500).send({
        error: 'Failed to start recording',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Stop recording
  app.post<{
    Params: { recordingId: string };
  }>('/api/preview/recording/:recordingId/stop', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    try {
      const result = await stopRecording(request.params.recordingId);

      if (!result) {
        reply.code(404).send({ error: 'Recording not found' });
        return;
      }

      reply.send({
        success: true,
        filename: result.path.split('/').pop(),
        duration: result.duration
      });
    } catch (error) {
      console.error('Recording stop error:', error);
      reply.code(500).send({
        error: 'Failed to stop recording',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // List screenshots
  app.get('/api/preview/screenshots', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    try {
      const screenshots = await listScreenshots();
      reply.send({ screenshots });
    } catch (error) {
      console.error('List screenshots error:', error);
      reply.code(500).send({ error: 'Failed to list screenshots' });
    }
  });

  // Get screenshot file
  app.get<{
    Params: { filename: string };
  }>('/api/preview/screenshots/:filename', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    try {
      const buffer = await getScreenshot(request.params.filename);

      if (!buffer) {
        reply.code(404).send({ error: 'Screenshot not found' });
        return;
      }

      reply.type('image/png').send(buffer);
    } catch (error) {
      console.error('Get screenshot error:', error);
      reply.code(500).send({ error: 'Failed to get screenshot' });
    }
  });

  // Delete screenshot
  app.delete<{
    Params: { filename: string };
  }>('/api/preview/screenshots/:filename', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    try {
      const success = await deleteScreenshot(request.params.filename);

      if (!success) {
        reply.code(404).send({ error: 'Screenshot not found' });
        return;
      }

      reply.send({ success: true });
    } catch (error) {
      console.error('Delete screenshot error:', error);
      reply.code(500).send({ error: 'Failed to delete screenshot' });
    }
  });
}
