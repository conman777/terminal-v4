import type { FastifyInstance } from 'fastify';
import { exec } from 'node:child_process';
import { clearCookies, listCookies, hasCookies } from '../preview/cookie-store';
import { getProxyLogs, clearProxyLogs, getActivePreviewPorts } from '../preview/request-log-store';

export async function registerPreviewApiRoutes(app: FastifyInstance): Promise<void> {
  // Preview: Get stored cookies for a port
  app.get<{ Params: { port: string } }>('/api/preview/:port/cookies', async (request, reply) => {
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    reply.send({
      port,
      hasCookies: hasCookies(port),
      cookies: listCookies(port)
    });
  });

  // Preview: Clear stored cookies for a port
  app.delete<{ Params: { port: string } }>('/api/preview/:port/cookies', async (request, reply) => {
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    clearCookies(port);
    reply.send({ success: true, port });
  });

  // Preview: Get server-side proxy request logs for a port
  app.get<{ Params: { port: string }; Querystring: { since?: string } }>('/api/preview/:port/proxy-logs', async (request, reply) => {
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
    const since = request.query.since ? parseInt(request.query.since, 10) : undefined;
    const logs = getProxyLogs(port, since);
    reply.send({ port, logs });
  });

  // Preview: Clear server-side proxy logs for a port
  app.delete<{ Params: { port: string } }>('/api/preview/:port/proxy-logs', async (request, reply) => {
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
    clearProxyLogs(port);
    reply.send({ success: true, port });
  });

  // Preview: List active/available ports for preview
  app.get('/api/preview/active-ports', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Get ports that have been previewed (from log store)
    const previewedPorts = getActivePreviewPorts();

    // Scan for listening ports with process names and working directories
    const portInfo = await new Promise<Map<number, { process: string; cwd: string | null }>>((resolve) => {
      // ss -tlnp output format: LISTEN  0  128  *:3000  *:*  users:(("node",pid=1234,fd=12))
      exec('ss -tlnp 2>/dev/null | grep LISTEN', async (error, stdout) => {
        const portMap = new Map<number, { process: string; cwd: string | null }>();
        if (error) {
          resolve(portMap);
          return;
        }
        const lines = stdout.trim().split('\n');
        const cwdPromises: Promise<void>[] = [];

        for (const line of lines) {
          // Extract port from 4th column (e.g., *:3000 or 0.0.0.0:3000 or [::]:3000)
          const portMatch = line.match(/[:\s](\d+)\s+[\d\.\*:\[\]]+:\*/);
          if (!portMatch) continue;
          const port = parseInt(portMatch[1], 10);
          if (isNaN(port) || port <= 1024 || port >= 65535 || port === 3020) continue;

          // Extract process name and PID from users:(("name",pid=1234,...)) format
          const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
          const processName = processMatch ? processMatch[1] : '';
          const pid = processMatch ? processMatch[2] : null;

          portMap.set(port, { process: processName, cwd: null });

          // Try to get the working directory for more context
          // Validate PID is purely numeric to prevent command injection
          if (pid && /^\d+$/.test(pid)) {
            const cwdPromise = (async () => {
              try {
                // Use fs.readlink instead of exec for safety
                const { readlink } = await import('fs/promises');
                const cwd = await readlink(`/proc/${pid}/cwd`);
                if (cwd) {
                  // Get just the last directory name
                  const dirName = cwd.split('/').filter(Boolean).pop() || cwd;
                  const existing = portMap.get(port);
                  if (existing) {
                    existing.cwd = dirName;
                  }
                }
              } catch {
                // Process may have exited, ignore
              }
            })();
            cwdPromises.push(cwdPromise);
          }
        }

        await Promise.all(cwdPromises);
        resolve(portMap);
      });
    });

    const listeningPorts = Array.from(portInfo.keys());

    // Common dev ports to highlight
    const commonDevPorts = [3000, 3001, 3002, 3003, 4000, 5000, 5173, 5174, 8000, 8080, 8888];

    // Combine and dedupe
    const allPorts = [...new Set([...previewedPorts, ...listeningPorts])].sort((a, b) => a - b);

    // Build response with metadata
    const ports = allPorts.map(port => {
      const info = portInfo.get(port);
      return {
        port,
        listening: listeningPorts.includes(port),
        previewed: previewedPorts.includes(port),
        common: commonDevPorts.includes(port),
        process: info?.process || null,
        cwd: info?.cwd || null
      };
    });

    reply.send({ ports });
  });
}
