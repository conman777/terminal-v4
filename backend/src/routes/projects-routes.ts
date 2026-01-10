import type { FastifyInstance } from 'fastify';
import { scanForProjects, addCustomScanDirectory, removeCustomScanDirectory, getCustomScanDirectories } from '../services/project-scanner';

export async function registerProjectsRoutes(app: FastifyInstance): Promise<void> {
  // Projects: Scan for git repositories
  app.get<{ Querystring: { force?: string } }>('/api/projects/scan', async (request, reply) => {
    const force = request.query.force === 'true';
    try {
      const result = await scanForProjects(force);
      reply.send(result);
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to scan for projects',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Projects: Get custom scan directories
  app.get('/api/projects/scan-dirs', async (request, reply) => {
    reply.send({ directories: getCustomScanDirectories() });
  });

  // Projects: Add a custom scan directory
  app.post<{ Body: { path: string } }>('/api/projects/scan-dirs', async (request, reply) => {
    const { path: dirPath } = request.body;
    if (!dirPath || typeof dirPath !== 'string') {
      reply.code(400).send({ error: 'Path is required' });
      return;
    }

    const added = addCustomScanDirectory(dirPath);
    if (added) {
      // Trigger a rescan to include new directory
      const result = await scanForProjects(true);
      reply.send({ success: true, directories: getCustomScanDirectories(), projects: result.projects });
    } else {
      reply.send({ success: false, message: 'Directory already in scan list', directories: getCustomScanDirectories() });
    }
  });

  // Projects: Remove a custom scan directory
  app.delete<{ Body: { path: string } }>('/api/projects/scan-dirs', async (request, reply) => {
    const { path: dirPath } = request.body;
    if (!dirPath || typeof dirPath !== 'string') {
      reply.code(400).send({ error: 'Path is required' });
      return;
    }

    const removed = removeCustomScanDirectory(dirPath);
    reply.send({ success: removed, directories: getCustomScanDirectories() });
  });
}
