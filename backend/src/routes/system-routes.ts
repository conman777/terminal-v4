import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import os from 'node:os';

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

  // Get system stats (RAM and CPU)
  app.get('/api/system/stats', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Memory stats
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // CPU stats - sample twice with 100ms delay for instantaneous usage
    const getCpuTimes = () => {
      return os.cpus().map(cpu => ({
        idle: cpu.times.idle,
        total: Object.values(cpu.times).reduce((a, b) => a + b, 0)
      }));
    };

    const startTimes = getCpuTimes();
    await new Promise(resolve => setTimeout(resolve, 100));
    const endTimes = getCpuTimes();

    const cpuUsage = startTimes.reduce((acc, start, i) => {
      const end = endTimes[i];
      const idleDiff = end.idle - start.idle;
      const totalDiff = end.total - start.total;
      return acc + (totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0);
    }, 0) / startTimes.length;

    return {
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percentage: Math.round((usedMem / totalMem) * 100)
      },
      cpu: {
        percentage: Math.round(cpuUsage),
        cores: os.cpus().length
      }
    };
  });
}
