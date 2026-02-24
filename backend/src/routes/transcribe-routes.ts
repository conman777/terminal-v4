import type { FastifyInstance } from 'fastify';
import { getUserGroqApiKey } from './settings-routes';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL;

interface TranscribeResponse {
  text: string;
}

export async function registerTranscribeRoutes(app: FastifyInstance): Promise<void> {
  // Health check endpoint - verify transcription is available before recording
  // Optional ?provider=local|groq to check a specific provider only
  app.get('/api/transcribe/health', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ ok: false, reason: 'unauthorized' });
    }

    const provider = (request.query as Record<string, string>).provider;

    // Check local whisper (if requested or auto-detect)
    if (!provider || provider === 'local') {
      if (WHISPER_SERVER_URL) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const resp = await fetch(`${WHISPER_SERVER_URL}/`, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (resp.ok) return { ok: true, provider: 'local' };
        } catch {
          // Fall through
        }
      }
      if (provider === 'local') {
        return { ok: false, reason: 'whisper_unavailable' };
      }
    }

    // Check Groq (if requested or auto-detect fallback)
    if (!provider || provider === 'groq') {
      const userApiKey = getUserGroqApiKey(userId);
      const apiKey = userApiKey || process.env.GROQ_API_KEY;

      if (!apiKey) {
        return { ok: false, reason: 'no_api_key' };
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch('https://api.groq.com/openai/v1/models', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 401) {
          return { ok: false, reason: 'invalid_api_key' };
        }
        if (response.status === 429) {
          return { ok: false, reason: 'rate_limited' };
        }
        if (!response.ok) {
          return { ok: false, reason: 'api_error' };
        }

        return { ok: true, provider: 'groq' };
      } catch (err: unknown) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          return { ok: false, reason: 'timeout' };
        }
        return { ok: false, reason: 'network_error' };
      }
    }

    return { ok: false, reason: 'no_provider' };
  });

  app.post('/api/transcribe', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    try {
      const data = await request.file();
      if (!data) {
        reply.code(400).send({ error: 'No audio file provided' });
        return;
      }

      const audioBuffer = await data.toBuffer();

      // Validate file size (max 25MB)
      if (audioBuffer.length > 25 * 1024 * 1024) {
        reply.code(400).send({ error: 'Audio file too large (max 25MB)' });
        return;
      }

      const mimeType = data.mimetype || 'audio/webm';
      const filename = data.filename || 'audio.webm';
      const provider = (request.query as Record<string, string>).provider;

      // Try local whisper.cpp (if requested or auto-detect)
      if ((!provider || provider === 'local') && WHISPER_SERVER_URL) {
        try {
          const formData = new FormData();
          formData.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
          formData.append('response_format', 'json');

          const resp = await fetch(`${WHISPER_SERVER_URL}/inference`, {
            method: 'POST',
            body: formData
          });

          if (resp.ok) {
            const result = await resp.json() as Record<string, unknown>;
            if (result.error) {
              app.log.warn({ error: result.error }, 'Local whisper returned error');
              if (provider === 'local') {
                reply.code(502).send({ error: `Local Whisper error: ${result.error}` });
                return;
              }
              // Fall through to Groq
            } else {
              const text = (typeof result.text === 'string' ? result.text : '').trim();
              if (text) return { text, provider: 'local' };
              return reply.code(200).send({ text: '', message: 'No speech detected' });
            }
          }
          if (provider === 'local') {
            reply.code(502).send({ error: 'Local Whisper transcription failed' });
            return;
          }
          app.log.warn({ status: resp.status }, 'Local whisper failed, falling back to Groq');
        } catch (err) {
          if (provider === 'local') {
            reply.code(502).send({ error: 'Local Whisper server error' });
            return;
          }
          app.log.warn({ err }, 'Local whisper error, falling back to Groq');
        }
      }

      if (provider === 'local' && !WHISPER_SERVER_URL) {
        reply.code(400).send({ error: 'Local Whisper server not configured' });
        return;
      }

      // Fall back to Groq API (if requested or auto-detect)
      if (!provider || provider === 'groq') {
        const userApiKey = getUserGroqApiKey(userId);
        const apiKey = userApiKey || process.env.GROQ_API_KEY;

        app.log.info({
          userId,
          hasUserKey: !!userApiKey,
          hasEnvKey: !!process.env.GROQ_API_KEY,
          keyPrefix: apiKey ? apiKey.substring(0, 8) : 'none'
        }, 'Transcribe request (Groq)');

        if (!apiKey) {
          reply.code(400).send({
            error: 'No transcription service available',
            message: provider === 'groq' ? 'No Groq API key configured' : 'Local Whisper server is down and no Groq API key is configured'
          });
          return;
        }

        const formData = new FormData();
        formData.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
        formData.append('model', 'whisper-large-v3');
        formData.append('response_format', 'json');

        const response = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`
          },
          body: formData
        });

        if (!response.ok) {
          const errorText = await response.text();
          app.log.error({
            status: response.status,
            error: errorText,
            audioSize: audioBuffer.length,
            mimeType,
            filename
          }, 'Groq API error');
          reply.code(502).send({ error: 'Transcription failed', details: errorText });
          return;
        }

        const result = await response.json() as TranscribeResponse;

        if (!result.text || result.text.trim() === '') {
          reply.code(200).send({ text: '', message: 'No speech detected' });
          return;
        }

        return { text: result.text.trim(), provider: 'groq' };
      }

      reply.code(400).send({ error: 'No transcription provider available' });
    } catch (error) {
      app.log.error(error, 'Transcription error');
      reply.code(500).send({ error: 'Failed to transcribe audio' });
    }
  });
}
