import type { FastifyInstance } from 'fastify';
import {
  loadBookmarks,
  getAllBookmarks,
  createBookmark,
  updateBookmark,
  deleteBookmark
} from '../bookmarks/bookmark-store';
import { bookmarkCreateRequestSchema, bookmarkUpdateRequestSchema } from './schemas';

interface BookmarkIdParams {
  id: string;
}

export async function registerBookmarkRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/bookmarks - List all bookmarks
  app.get('/api/bookmarks', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    await loadBookmarks(userId);
    reply.send({ bookmarks: getAllBookmarks(userId) });
  });

  // POST /api/bookmarks - Create new bookmark
  app.post('/api/bookmarks', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = bookmarkCreateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid bookmark request body',
        details: result.error.flatten()
      });
      return;
    }

    const bookmark = await createBookmark(userId, result.data.name, result.data.command, result.data.category);
    reply.code(201).send({ bookmark });
  });

  // PUT /api/bookmarks/:id - Update bookmark
  app.put<{ Params: BookmarkIdParams }>('/api/bookmarks/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = bookmarkUpdateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid bookmark update body',
        details: result.error.flatten()
      });
      return;
    }

    const bookmark = await updateBookmark(userId, request.params.id, result.data);
    if (!bookmark) {
      reply.code(404).send({ error: 'Bookmark not found' });
      return;
    }

    reply.send({ bookmark });
  });

  // DELETE /api/bookmarks/:id - Delete bookmark
  app.delete<{ Params: BookmarkIdParams }>('/api/bookmarks/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const deleted = await deleteBookmark(userId, request.params.id);
    if (!deleted) {
      reply.code(404).send({ error: 'Bookmark not found' });
      return;
    }

    reply.code(204).send();
  });
}
