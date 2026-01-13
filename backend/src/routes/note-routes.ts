import type { FastifyInstance } from 'fastify';
import {
  loadNotes,
  getAllNotes,
  createNote,
  updateNote,
  deleteNote
} from '../notes/note-store';
import { noteCreateRequestSchema, noteUpdateRequestSchema } from './schemas';

interface NoteIdParams {
  id: string;
}

export async function registerNoteRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/notes - List all notes
  app.get('/api/notes', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    await loadNotes(userId);
    reply.send({ notes: getAllNotes(userId) });
  });

  // POST /api/notes - Create new note
  app.post('/api/notes', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = noteCreateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid note request body',
        details: result.error.flatten()
      });
      return;
    }

    const note = await createNote(userId, result.data.title, result.data.content, result.data.category);
    reply.code(201).send({ note });
  });

  // PUT /api/notes/:id - Update note
  app.put<{ Params: NoteIdParams }>('/api/notes/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = noteUpdateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid note update body',
        details: result.error.flatten()
      });
      return;
    }

    const note = await updateNote(userId, request.params.id, result.data);
    if (!note) {
      reply.code(404).send({ error: 'Note not found' });
      return;
    }

    reply.send({ note });
  });

  // DELETE /api/notes/:id - Delete note
  app.delete<{ Params: NoteIdParams }>('/api/notes/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const deleted = await deleteNote(userId, request.params.id);
    if (!deleted) {
      reply.code(404).send({ error: 'Note not found' });
      return;
    }

    reply.code(204).send();
  });
}
