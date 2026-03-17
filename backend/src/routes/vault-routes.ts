import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../database/db';
import { decryptSecret, encryptSecret } from '../utils/secret-crypto';

interface VaultIdParams {
  id: string;
}

interface AddKeyBody {
  name: string;
  value: string;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

function readStoredValue(value: string): string {
  try {
    return decryptSecret(value);
  } catch {
    return value;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export async function registerVaultRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/vault - list all keys (masked)
  app.get('/api/vault', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const db = getDatabase();
    const rows = db.prepare(
      'SELECT id, key_name, key_value, created_at FROM api_key_vault WHERE user_id = ? ORDER BY created_at ASC'
    ).all(userId) as { id: string; key_name: string; key_value: string; created_at: string }[];

    return {
      keys: rows.map(row => ({
        id: row.id,
        name: row.key_name,
        maskedValue: maskValue(readStoredValue(row.key_value)),
        createdAt: row.created_at
      }))
    };
  });

  // POST /api/vault - add a key
  app.post<{ Body: AddKeyBody }>('/api/vault', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const { name, value } = request.body || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
      reply.code(400).send({ error: 'Key name must be 1-100 characters' });
      return;
    }
    if (!value || typeof value !== 'string' || value.length === 0 || value.length > 10000) {
      reply.code(400).send({ error: 'Key value must be 1-10000 characters' });
      return;
    }

    const db = getDatabase();
    const trimmedName = name.trim();
    const id = randomUUID();
    const now = new Date().toISOString();
    const encryptedValue = encryptSecret(value);
    try {
      db.prepare(
        'INSERT INTO api_key_vault (id, user_id, key_name, key_value, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, userId, trimmedName, encryptedValue, now);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        reply.code(409).send({ error: `A key named "${trimmedName}" already exists` });
        return;
      }
      throw error;
    }

    return {
      key: {
        id,
        name: trimmedName,
        maskedValue: maskValue(value),
        createdAt: now
      }
    };
  });

  // GET /api/vault/:id/reveal - reveal actual key value
  app.get<{ Params: VaultIdParams }>('/api/vault/:id/reveal', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const db = getDatabase();
    const row = db.prepare(
      'SELECT key_value FROM api_key_vault WHERE id = ? AND user_id = ?'
    ).get(request.params.id, userId) as { key_value: string } | undefined;

    if (!row) {
      reply.code(404).send({ error: 'Key not found' });
      return;
    }
    return { value: readStoredValue(row.key_value) };
  });

  // DELETE /api/vault/:id - delete a key
  app.delete<{ Params: VaultIdParams }>('/api/vault/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const db = getDatabase();
    const result = db.prepare(
      'DELETE FROM api_key_vault WHERE id = ? AND user_id = ?'
    ).run(request.params.id, userId);

    if (result.changes === 0) {
      reply.code(404).send({ error: 'Key not found' });
      return;
    }

    reply.code(204).send();
  });
}
