import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';

// Absolute path to rebuild script
const REBUILD_SCRIPT = '/home/conor/terminal-v4/rebuild.sh';
const PROJECT_ROOT = '/home/conor/terminal-v4';

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // Trigger app rebuild
  app.post('/api/system/rebuild', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    return new Promise((resolve) => {
      const child = spawn('bash', [REBUILD_SCRIPT], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, message: 'Rebuild completed', output: stdout });
        } else {
          reply.code(500);
          resolve({ success: false, error: 'Rebuild failed', output: stderr || stdout });
        }
      });

      child.on('error', (err) => {
        reply.code(500);
        resolve({ success: false, error: err.message });
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        child.kill();
        reply.code(500);
        resolve({ success: false, error: 'Rebuild timed out' });
      }, 5 * 60 * 1000);
    });
  });
}
