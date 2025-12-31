import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRepoProcesses, startRepo, stopProcess } from '../processes/process-service';

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
      reply.code(500).send({ error: stopResult.error });
      return;
    }

    reply.send({ success: true });
  });
}
