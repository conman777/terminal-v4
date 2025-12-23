import type { FastifyInstance } from 'fastify';
import { getUserGroqApiKey } from './settings-routes';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

interface TranscribeResponse {
  text: string;
}

export async function registerTranscribeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/transcribe', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Try user's API key first, fall back to environment variable
    const userApiKey = getUserGroqApiKey(userId);
    const apiKey = userApiKey || process.env.GROQ_API_KEY;

    if (!apiKey) {
      reply.code(400).send({
        error: 'Groq API key not configured',
        message: 'Please add your Groq API key in Settings'
      });
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

      // Determine MIME type from the uploaded file
      const mimeType = data.mimetype || 'audio/webm';
      const filename = data.filename || 'audio.webm';

      // Create form data for Groq API
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
        app.log.error({ status: response.status, error: errorText }, 'Groq API error');
        reply.code(502).send({ error: 'Transcription failed', details: errorText });
        return;
      }

      const result = await response.json() as TranscribeResponse;

      if (!result.text || result.text.trim() === '') {
        reply.code(200).send({ text: '', message: 'No speech detected' });
        return;
      }

      return { text: result.text.trim() };
    } catch (error) {
      app.log.error(error, 'Transcription error');
      reply.code(500).send({ error: 'Failed to transcribe audio' });
    }
  });
}
