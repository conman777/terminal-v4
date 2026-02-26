import type { FastifyInstance } from 'fastify';
import {
  beginRegistration,
  completeRegistration,
  beginAuthentication,
  completeAuthentication
} from './passkey-service.js';
import { getUserById } from './user-store.js';
import { getPasskeyCredentialsByUserId, deletePasskeyCredential } from './passkey-store.js';

export function registerPasskeyRoutes(app: FastifyInstance): void {
  // Begin passkey registration (requires JWT auth)
  app.post('/api/auth/passkey/register/begin', async (request, reply) => {
    const userId = (request as any).userId;
    if (!userId) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    const user = getUserById(userId);
    if (!user) {
      reply.status(401).send({ error: 'User not found' });
      return;
    }

    try {
      const options = await beginRegistration(user);
      reply.send(options);
    } catch (error) {
      if (error instanceof Error) {
        reply.status(400).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  // Complete passkey registration (requires JWT auth)
  app.post<{ Body: { credential: any; name?: string } }>(
    '/api/auth/passkey/register/complete',
    async (request, reply) => {
      const userId = (request as any).userId;
      if (!userId) {
        reply.status(401).send({ error: 'Unauthorized' });
        return;
      }

      const user = getUserById(userId);
      if (!user) {
        reply.status(401).send({ error: 'User not found' });
        return;
      }

      const { credential, name } = request.body || ({} as any);
      if (!credential) {
        reply.status(400).send({ error: 'Missing credential' });
        return;
      }

      try {
        const saved = await completeRegistration(user, credential, name);
        reply.send({
          id: saved.id,
          name: saved.name,
          credentialId: saved.credential_id,
          createdAt: saved.created_at
        });
      } catch (error) {
        if (error instanceof Error) {
          reply.status(400).send({ error: error.message });
          return;
        }
        throw error;
      }
    }
  );

  // Begin passkey authentication (public)
  app.post<{ Body: { username: string } }>(
    '/api/auth/passkey/authenticate/begin',
    async (request, reply) => {
      const { username } = request.body || ({} as any);
      if (!username) {
        reply.status(400).send({ error: 'Username is required' });
        return;
      }

      try {
        const options = await beginAuthentication(username);
        reply.send(options);
      } catch (error) {
        if (error instanceof Error) {
          reply.status(400).send({ error: error.message });
          return;
        }
        throw error;
      }
    }
  );

  // Complete passkey authentication (public)
  app.post<{ Body: { username: string; credential: any } }>(
    '/api/auth/passkey/authenticate/complete',
    async (request, reply) => {
      const { username, credential } = request.body || ({} as any);
      if (!username || !credential) {
        reply.status(400).send({ error: 'Missing username or credential' });
        return;
      }

      try {
        const result = await completeAuthentication(username, credential);
        reply.send(result);
      } catch (error) {
        if (error instanceof Error) {
          reply.status(401).send({ error: error.message });
          return;
        }
        throw error;
      }
    }
  );

  // List passkey credentials for authenticated user
  app.get('/api/auth/passkey/credentials', async (request, reply) => {
    const userId = (request as any).userId;
    if (!userId) {
      reply.status(401).send({ error: 'Unauthorized' });
      return;
    }

    const credentials = getPasskeyCredentialsByUserId(userId);
    reply.send({
      credentials: credentials.map((c) => ({
        id: c.id,
        name: c.name,
        credentialId: c.credential_id,
        deviceType: c.device_type,
        backedUp: c.backed_up === 1,
        createdAt: c.created_at,
        lastUsedAt: c.last_used_at
      }))
    });
  });

  // Delete a passkey credential (requires JWT auth)
  app.delete<{ Params: { id: string } }>(
    '/api/auth/passkey/credentials/:id',
    async (request, reply) => {
      const userId = (request as any).userId;
      if (!userId) {
        reply.status(401).send({ error: 'Unauthorized' });
        return;
      }

      const { id } = request.params;
      const credentials = getPasskeyCredentialsByUserId(userId);
      const credential = credentials.find((c) => c.id === id);

      if (!credential) {
        reply.status(404).send({ error: 'Credential not found' });
        return;
      }

      deletePasskeyCredential(id);
      reply.send({ success: true });
    }
  );
}
