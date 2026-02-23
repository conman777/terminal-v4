import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { bitcoinRoutes } from './routes/bitcoin-routes';
import { aiRoutes } from './routes/ai-routes';

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

  fastify.get('/api/settings', async (_request, reply) => {
    const key = process.env.OPENROUTER_API_KEY || '';
    return reply.send({ hasApiKey: !!key && key !== 'your_key_here' });
  });

  fastify.post('/api/settings', async (request, reply) => {
    const { apiKey } = (request.body as { apiKey?: string }) || {};
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return reply.status(400).send({ error: 'API key is required' });
    }
    const envPath = path.resolve(__dirname, '../../.env');
    fs.writeFileSync(envPath, `OPENROUTER_API_KEY=${apiKey.trim()}\n`);
    process.env.OPENROUTER_API_KEY = apiKey.trim();
    return reply.send({ ok: true });
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
