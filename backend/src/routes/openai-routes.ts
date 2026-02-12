import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getUserOpenAIApiKey } from './settings-routes';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_SEARCH_MODEL = process.env.OPENAI_SEARCH_MODEL || 'gpt-4o-mini-search-preview';
const DEFAULT_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(8000),
  model: z.string().trim().min(1).max(120).optional(),
  searchContextSize: z.enum(['low', 'medium', 'high']).optional()
});

const ImageRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  model: z.string().trim().min(1).max(120).optional(),
  size: z.enum(['1024x1024', '1024x1536', '1536x1024', 'auto']).optional()
});

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: Record<string, unknown>;
  id?: string;
}

function getApiKeyForUser(userId: string): string | null {
  return getUserOpenAIApiKey(userId) || process.env.OPENAI_API_KEY || null;
}

export async function registerOpenAIRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/openai/health', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ ok: false, reason: 'unauthorized' });
    }

    const apiKey = getApiKeyForUser(userId);
    if (!apiKey) {
      return { ok: false, reason: 'no_api_key' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${OPENAI_API_BASE}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.status === 401) return { ok: false, reason: 'invalid_api_key' };
      if (response.status === 429) return { ok: false, reason: 'rate_limited' };
      if (!response.ok) return { ok: false, reason: 'api_error' };
      return { ok: true };
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        return { ok: false, reason: 'timeout' };
      }
      return { ok: false, reason: 'network_error' };
    }
  });

  app.post('/api/openai/search', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const validation = SearchRequestSchema.safeParse(request.body);
    if (!validation.success) {
      reply.code(400).send({
        error: 'Invalid request body',
        details: validation.error.flatten()
      });
      return;
    }

    const apiKey = getApiKeyForUser(userId);
    if (!apiKey) {
      reply.code(400).send({ error: 'OpenAI API key not configured' });
      return;
    }

    const model = validation.data.model || DEFAULT_SEARCH_MODEL;
    const searchContextSize = validation.data.searchContextSize || 'low';

    try {
      const response = await fetch(`${OPENAI_API_BASE}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          input: validation.data.query,
          tools: [
            {
              type: 'web_search_preview',
              search_context_size: searchContextSize
            }
          ]
        })
      });

      const raw = await response.text();
      if (!response.ok) {
        reply.code(502).send({
          error: 'OpenAI search request failed',
          details: raw
        });
        return;
      }

      const result = JSON.parse(raw) as OpenAIResponse;
      const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((c) => c.type === 'output_text')?.text || '';

      reply.send({
        text: outputText,
        model,
        id: result.id || null,
        usage: result.usage || null
      });
    } catch (error) {
      app.log.error(error, 'OpenAI search error');
      reply.code(500).send({ error: 'Failed to run OpenAI search' });
    }
  });

  app.post('/api/openai/image', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const validation = ImageRequestSchema.safeParse(request.body);
    if (!validation.success) {
      reply.code(400).send({
        error: 'Invalid request body',
        details: validation.error.flatten()
      });
      return;
    }

    const apiKey = getApiKeyForUser(userId);
    if (!apiKey) {
      reply.code(400).send({ error: 'OpenAI API key not configured' });
      return;
    }

    const model = validation.data.model || DEFAULT_IMAGE_MODEL;
    const size = validation.data.size || '1024x1024';

    try {
      const response = await fetch(`${OPENAI_API_BASE}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          prompt: validation.data.prompt,
          size
        })
      });

      const raw = await response.text();
      if (!response.ok) {
        reply.code(502).send({
          error: 'OpenAI image request failed',
          details: raw
        });
        return;
      }

      const parsed = JSON.parse(raw) as { data?: Array<{ b64_json?: string; revised_prompt?: string }>; created?: number };
      const first = parsed.data?.[0];
      if (!first?.b64_json) {
        reply.code(502).send({ error: 'OpenAI image response missing image data' });
        return;
      }

      reply.send({
        imageBase64: first.b64_json,
        revisedPrompt: first.revised_prompt || null,
        created: parsed.created || null,
        model
      });
    } catch (error) {
      app.log.error(error, 'OpenAI image error');
      reply.code(500).send({ error: 'Failed to generate image with OpenAI' });
    }
  });
}
