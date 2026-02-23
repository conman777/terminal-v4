import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { bitcoinRoutes } from './routes/bitcoin-routes.js';
import { aiRoutes } from './routes/ai-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = parseInt(process.env.PORT || '3025', 10);

async function start(): Promise<void> {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, { origin: true });

  const frontendDistPath = path.resolve(__dirname, '../../frontend/dist');
  if (!fs.existsSync(frontendDistPath)) {
    fs.mkdirSync(frontendDistPath, { recursive: true });
  }
  await fastify.register(fastifyStatic, {
    root: frontendDistPath,
    wildcard: false,
  });

  fastify.get('/api/health', async (_request, reply) => {
    return reply.send({ ok: true, timestamp: new Date().toISOString() });
  });

  await fastify.register(bitcoinRoutes);
  await fastify.register(aiRoutes);

  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    try {
      return await reply.sendFile('index.html');
    } catch {
      return reply.status(404).send({ error: 'Frontend not built. Run: cd frontend && npm run build' });
    }
  });

  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Bitcoin Overlay backend running on http://0.0.0.0:${PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
