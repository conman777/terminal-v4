import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { threadUpdateRequestSchema } from './schemas';
import {
  updateThreadMetadata,
  getThreadMetadata,
  loadSession,
  saveSession,
  createDefaultThreadMetadata,
  type ThreadGitStats
} from '../terminal/session-store';
import type { TerminalIdParams } from './types';

const execFileAsync = promisify(execFile);

/**
 * Detect the git root path for a given directory
 * Uses execFile to avoid shell injection
 */
async function detectGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 5000
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get git diff stats for a session's working directory
 * Uses execFile to avoid shell injection
 */
async function getGitDiffStats(cwd: string): Promise<ThreadGitStats | null> {
  try {
    // Try to get diff against HEAD first
    let result: string;
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], {
        cwd,
        timeout: 10000
      });
      result = stdout;
    } catch {
      // Fall back to just diff if no HEAD (new repo)
      const { stdout } = await execFileAsync('git', ['diff', '--stat'], {
        cwd,
        timeout: 10000
      });
      result = stdout;
    }

    // Parse output like: "15 files changed, 450 insertions(+), 200 deletions(-)"
    const match = result.match(/(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/);
    if (match) {
      return {
        linesAdded: parseInt(match[1], 10),
        linesRemoved: parseInt(match[2], 10)
      };
    }

    // Try parsing simpler format: "X insertions(+)" or "Y deletions(-)"
    const insertions = result.match(/(\d+) insertions?\(\+\)/);
    const deletions = result.match(/(\d+) deletions?\(-\)/);
    if (insertions || deletions) {
      return {
        linesAdded: insertions ? parseInt(insertions[1], 10) : 0,
        linesRemoved: deletions ? parseInt(deletions[1], 10) : 0
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  /**
   * PATCH /api/terminal/:id/thread - Update thread metadata
   */
  app.patch<{ Params: TerminalIdParams }>('/api/terminal/:id/thread', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = threadUpdateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid thread update body',
        details: result.error.flatten()
      });
      return;
    }

    const session = await updateThreadMetadata(userId, request.params.id, result.data);
    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    reply.send({ thread: session.thread });
  });

  /**
   * GET /api/terminal/:id/thread - Get thread metadata
   */
  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/thread', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const thread = await getThreadMetadata(userId, request.params.id);
    if (!thread) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    reply.send({ thread });
  });

  /**
   * GET /api/terminal/:id/git-stats - Get git diff stats for session
   */
  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/git-stats', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const session = await loadSession(userId, request.params.id);
    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    const [gitStats, projectPath] = await Promise.all([
      getGitDiffStats(session.cwd),
      detectGitRoot(session.cwd)
    ]);

    // Update session with latest stats and project path
    const thread = session.thread || createDefaultThreadMetadata(session.cwd);
    session.thread = {
      ...thread,
      gitStats,
      projectPath,
      lastActivityAt: new Date().toISOString()
    };
    await saveSession(userId, session);

    reply.send({
      gitStats,
      projectPath
    });
  });

  /**
   * POST /api/terminal/:id/detect-project - Detect and set project path
   */
  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/detect-project', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const session = await loadSession(userId, request.params.id);
    if (!session) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    const projectPath = await detectGitRoot(session.cwd);

    // Update session with project path
    const thread = session.thread || createDefaultThreadMetadata(session.cwd);
    session.thread = {
      ...thread,
      projectPath,
      lastActivityAt: new Date().toISOString()
    };
    await saveSession(userId, session);

    reply.send({ projectPath });
  });
}
