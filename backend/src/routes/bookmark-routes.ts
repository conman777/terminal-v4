import type { FastifyInstance } from 'fastify';
import {
  loadBookmarks,
  getAllBookmarks,
  createBookmark,
  updateBookmark,
  deleteBookmark
} from '../bookmarks/bookmark-store';
import { bookmarkCreateRequestSchema, bookmarkUpdateRequestSchema } from './schemas';

export async function registerBookmarkRoutes(app: FastifyInstance): Promise<void> {
  // Load bookmarks on startup
  await loadBookmarks();

  // GET /api/bookmarks - List all bookmarks
  app.get('/api/bookmarks', async () => ({
    bookmarks: getAllBookmarks()
  }));

  // POST /api/bookmarks - Create new bookmark
  app.post('/api/bookmarks', async (request, reply) => {
    const result = bookmarkCreateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid bookmark request body',
        details: result.error.flatten()
      });
      return;
    }

    const bookmark = await createBookmark(result.data.name, result.data.command, result.data.category);
    reply.code(201).send({ bookmark });
  });

  // PUT /api/bookmarks/:id - Update bookmark
  app.put('/api/bookmarks/:id', async (request, reply) => {
    const result = bookmarkUpdateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid bookmark update body',
        details: result.error.flatten()
      });
      return;
    }

    const bookmark = await updateBookmark(request.params.id, result.data);
    if (!bookmark) {
      reply.code(404).send({ error: 'Bookmark not found' });
      return;
    }

    reply.send({ bookmark });
  });

  // DELETE /api/bookmarks/:id - Delete bookmark
  app.delete('/api/bookmarks/:id', async (request, reply) => {
    const deleted = await deleteBookmark(request.params.id);
    if (!deleted) {
      reply.code(404).send({ error: 'Bookmark not found' });
      return;
    }

    reply.code(204).send();
  });
}
