/**
 * Preview Performance Routes
 *
 * API endpoints for performance monitoring and WebSocket debugging
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  trackPerformanceMetric,
  getPerformanceMetrics,
  clearPerformanceMetrics,
  getLatestMetricTimestamp,
  type PerformanceMetric
} from '../browser/performance-service.js';
import {
  getWebSocketConnections,
  getWebSocketMessages,
  clearWebSocketLogs
} from '../preview/websocket-interceptor.js';

export async function registerPreviewPerformanceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/preview/:port/performance
   * Track performance metrics from client
   */
  app.post<{
    Params: { port: string };
    Body: { metrics: Omit<PerformanceMetric, 'port'>[] };
  }>('/api/preview/:port/performance', async (request: FastifyRequest<{
    Params: { port: string };
    Body: { metrics: Omit<PerformanceMetric, 'port'>[] };
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);
    if (Number.isNaN(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }

    const { metrics } = request.body;
    if (!Array.isArray(metrics)) {
      return reply.code(400).send({ error: 'metrics must be an array' });
    }

    // Track each metric
    for (const metric of metrics) {
      trackPerformanceMetric({
        ...metric,
        port
      });
    }

    return reply.send({ success: true, count: metrics.length });
  });

  /**
   * GET /api/preview/:port/performance
   * Get performance metrics for a port
   */
  app.get<{
    Params: { port: string };
    Querystring: { since?: string };
  }>('/api/preview/:port/performance', async (request: FastifyRequest<{
    Params: { port: string };
    Querystring: { since?: string };
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);
    if (Number.isNaN(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }

    const since = request.query.since ? parseInt(request.query.since, 10) : undefined;
    const metrics = getPerformanceMetrics(port, since);

    return reply.send({
      port,
      metrics,
      latestTimestamp: getLatestMetricTimestamp(port)
    });
  });

  /**
   * DELETE /api/preview/:port/performance
   * Clear performance metrics for a port
   */
  app.delete<{
    Params: { port: string };
  }>('/api/preview/:port/performance', async (request: FastifyRequest<{
    Params: { port: string };
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);
    if (Number.isNaN(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }

    clearPerformanceMetrics(port);
    return reply.send({ success: true });
  });

  /**
   * GET /api/preview/:port/websockets
   * Get WebSocket connections and messages
   */
  app.get<{
    Params: { port: string };
    Querystring: { connectionId?: string; direction?: 'sent' | 'received' };
  }>('/api/preview/:port/websockets', async (request: FastifyRequest<{
    Params: { port: string };
    Querystring: { connectionId?: string; direction?: 'sent' | 'received' };
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);
    if (Number.isNaN(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }

    const connections = getWebSocketConnections(port);
    const messages = getWebSocketMessages(
      port,
      request.query.connectionId,
      request.query.direction
    );

    return reply.send({
      port,
      connections,
      messages,
      messageCount: messages.length
    });
  });

  /**
   * DELETE /api/preview/:port/websockets
   * Clear WebSocket logs for a port
   */
  app.delete<{
    Params: { port: string };
  }>('/api/preview/:port/websockets', async (request: FastifyRequest<{
    Params: { port: string };
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);
    if (Number.isNaN(port)) {
      return reply.code(400).send({ error: 'Invalid port' });
    }

    clearWebSocketLogs(port);
    return reply.send({ success: true });
  });

  /**
   * WebSocket: /api/preview/:port/performance/stream
   * Stream real-time performance metrics
   */
  app.get<{
    Params: { port: string };
  }>('/api/preview/:port/performance/stream', { websocket: true }, (socket, request) => {
    const params = request.params as { port: string };
    const port = parseInt(params.port, 10);

    if (Number.isNaN(port)) {
      socket.close(1008, 'Invalid port');
      return;
    }

    let lastTimestamp = Date.now();
    let intervalId: NodeJS.Timeout;

    // Send updates every 1 second
    intervalId = setInterval(() => {
      try {
        const metrics = getPerformanceMetrics(port, lastTimestamp);
        const currentTimestamp = getLatestMetricTimestamp(port);

        if (currentTimestamp > lastTimestamp) {
          socket.send(JSON.stringify({
            type: 'performance-update',
            port,
            metrics,
            timestamp: currentTimestamp
          }));
          lastTimestamp = currentTimestamp;
        }
      } catch (error) {
        console.error('[performance-stream] Error sending update:', error);
      }
    }, 1000);

    socket.on('close', () => {
      clearInterval(intervalId);
    });

    socket.on('error', (error) => {
      console.error('[performance-stream] WebSocket error:', error);
      clearInterval(intervalId);
    });
  });
}
