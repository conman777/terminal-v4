import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRepoProcesses, startRepo, stopProcess } from '../processes/process-service';
import {
  getProcessLogsByPort,
  getProcessLogsByPid,
  getProcessInfoByPort,
  getProcessInfoByPid,
  getAllProcesses,
  getActiveProcesses,
  clearProcessLogs
} from '../preview/process-log-store';

const startRequestSchema = z.object({
  path: z.string().min(1, 'Path is required'),
});

const stopRequestSchema = z.object({
  pid: z.number().int().positive('PID must be a positive integer'),
});

export async function registerProcessRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/processes - List all repos with running status
  // Query param: paths (comma-separated list of repo paths)
  app.get('/api/processes', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Get repo paths from query param
    const query = request.query as { paths?: string };
    const pathsParam = query.paths || '';
    const repoPaths = pathsParam
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    if (repoPaths.length === 0) {
      reply.send({ repos: [] });
      return;
    }

    const repos = getRepoProcesses(repoPaths);
    reply.send({ repos });
  });

  // POST /api/processes/start - Start a repo's application
  app.post('/api/processes/start', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = startRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid request body',
        details: result.error.flatten(),
      });
      return;
    }

    const startResult = await startRepo(result.data.path);
    if (!startResult.success) {
      reply.code(500).send({ error: startResult.error });
      return;
    }

    reply.send({ success: true });
  });

  // POST /api/processes/stop - Stop a process by PID
  app.post('/api/processes/stop', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = stopRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid request body',
        details: result.error.flatten(),
      });
      return;
    }

    const stopResult = await stopProcess(result.data.pid);
    if (!stopResult.success) {
      const statusCode = stopResult.error === 'Process is not managed by this app' ? 403 : 500;
      reply.code(statusCode).send({ error: stopResult.error });
      return;
    }

    reply.send({ success: true });
  });

  // GET /api/preview/:port/process-logs - Get server-side logs for a port
  app.get('/api/preview/:port/process-logs', {
    config: { skipAuth: true } // Allow CLI/unauthenticated access for debugging
  }, async (request, reply) => {
    const params = request.params as { port: string };
    const port = parseInt(params.port, 10);

    if (isNaN(port) || port < 3000 || port > 65535) {
      return reply.code(400).send({ error: 'Invalid port. Must be 3000-65535.' });
    }

    const query = request.query as { since?: string; limit?: string };
    const since = query.since ? parseInt(query.since, 10) : undefined;
    const limit = query.limit ? parseInt(query.limit, 10) : undefined;

    const processInfo = getProcessInfoByPort(port);
    let logs = getProcessLogsByPort(port, since);

    // Apply limit if specified
    if (limit && limit > 0 && logs.length > limit) {
      logs = logs.slice(-limit);
    }

    return reply.send({
      port,
      process: processInfo ? {
        pid: processInfo.pid,
        command: processInfo.command,
        cwd: processInfo.cwd,
        startedAt: processInfo.startedAt,
        exitCode: processInfo.exitCode,
        exitedAt: processInfo.exitedAt,
        running: processInfo.exitedAt === null
      } : null,
      count: logs.length,
      logs
    });
  });

  // GET /api/process-logs/:pid - Get logs by PID directly
  app.get('/api/process-logs/:pid', {
    config: { skipAuth: true }
  }, async (request, reply) => {
    const params = request.params as { pid: string };
    const pid = parseInt(params.pid, 10);

    if (isNaN(pid) || pid <= 0) {
      return reply.code(400).send({ error: 'Invalid PID' });
    }

    const query = request.query as { since?: string; limit?: string };
    const since = query.since ? parseInt(query.since, 10) : undefined;
    const limit = query.limit ? parseInt(query.limit, 10) : undefined;

    const processInfo = getProcessInfoByPid(pid);
    if (!processInfo) {
      return reply.code(404).send({ error: 'Process not found' });
    }

    let logs = getProcessLogsByPid(pid, since);

    if (limit && limit > 0 && logs.length > limit) {
      logs = logs.slice(-limit);
    }

    return reply.send({
      pid,
      process: {
        port: processInfo.port,
        command: processInfo.command,
        cwd: processInfo.cwd,
        startedAt: processInfo.startedAt,
        exitCode: processInfo.exitCode,
        exitedAt: processInfo.exitedAt,
        running: processInfo.exitedAt === null
      },
      count: logs.length,
      logs
    });
  });

  // GET /api/process-logs - List all tracked processes
  app.get('/api/process-logs', {
    config: { skipAuth: true }
  }, async (request, reply) => {
    const query = request.query as { active?: string };
    const activeOnly = query.active === 'true';

    const processes = activeOnly ? getActiveProcesses() : getAllProcesses();

    return reply.send({
      count: processes.length,
      processes: processes.map(p => ({
        pid: p.pid,
        port: p.port,
        command: p.command,
        cwd: p.cwd,
        startedAt: p.startedAt,
        exitCode: p.exitCode,
        exitedAt: p.exitedAt,
        running: p.exitedAt === null,
        logCount: p.logs.length
      }))
    });
  });

  // DELETE /api/process-logs/:pid - Clear logs for a process
  app.delete('/api/process-logs/:pid', async (request, reply) => {
    const params = request.params as { pid: string };
    const pid = parseInt(params.pid, 10);

    if (isNaN(pid) || pid <= 0) {
      return reply.code(400).send({ error: 'Invalid PID' });
    }

    const cleared = clearProcessLogs(pid);
    return reply.send({ success: true, cleared });
  });
}
