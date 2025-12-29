import type { FastifyInstance } from 'fastify';
import { getDatabase } from '../database/db';

interface UserSettings {
  groqApiKey: string | null;
}

interface UpdateSettingsBody {
  groqApiKey?: string | null;
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // Get user settings
  app.get('/api/settings', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const db = getDatabase();
    const row = db.prepare('SELECT groq_api_key FROM user_settings WHERE user_id = ?').get(userId) as { groq_api_key: string | null } | undefined;

    // Mask the API key for display (show only last 4 chars)
    const groqApiKey = row?.groq_api_key;
    const maskedKey = groqApiKey ? `${'*'.repeat(Math.max(0, groqApiKey.length - 4))}${groqApiKey.slice(-4)}` : null;

    return {
      groqApiKey: maskedKey,
      hasGroqApiKey: !!groqApiKey
    };
  });

  // Update user settings
  app.patch<{ Body: UpdateSettingsBody }>('/api/settings', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const { groqApiKey } = request.body || {};

    if (groqApiKey !== undefined && groqApiKey !== null && typeof groqApiKey !== 'string') {
      reply.code(400).send({ error: 'Invalid Groq API key format' });
      return;
    }

    // Validate API key format if provided (Groq keys start with gsk_)
    if (groqApiKey !== undefined && groqApiKey !== null && groqApiKey !== '') {
      if (!groqApiKey.startsWith('gsk_')) {
        reply.code(400).send({ error: 'Invalid Groq API key format (should start with gsk_)' });
        return;
      }
      if (groqApiKey.length < 20) {
        reply.code(400).send({ error: 'Groq API key is too short' });
        return;
      }
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    // Upsert the settings
    const existing = db.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(userId);

    if (existing) {
      if (groqApiKey === null || groqApiKey === '') {
        // Clear the key
        db.prepare('UPDATE user_settings SET groq_api_key = NULL, updated_at = ? WHERE user_id = ?').run(now, userId);
      } else if (groqApiKey !== undefined) {
        db.prepare('UPDATE user_settings SET groq_api_key = ?, updated_at = ? WHERE user_id = ?').run(groqApiKey, now, userId);
      }
    } else {
      db.prepare('INSERT INTO user_settings (user_id, groq_api_key, updated_at) VALUES (?, ?, ?)').run(
        userId,
        groqApiKey || null,
        now
      );
    }

    return { success: true };
  });
}

// Helper function to get user's Groq API key (for use in transcribe route)
export function getUserGroqApiKey(userId: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT groq_api_key FROM user_settings WHERE user_id = ?').get(userId) as { groq_api_key: string | null } | undefined;
  return row?.groq_api_key || null;
}
