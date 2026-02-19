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

/** Strip ANSI/VT escape sequences from terminal output */
function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')   // CSI sequences (colors, cursor moves)
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences (window title etc.)
    .replace(/\x1b[^[\]]/g, '')                // other two-char escapes
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, ''); // non-printable control chars
}

/**
 * Extract the first sentence-like line from plain terminal text.
 * Looks for lines that resemble user prompts typed to Claude Code:
 * mostly alphabetic, not shell prompts or file paths.
 */
function extractTopicFromText(plainText: string): string | null {
  const lines = plainText.split(/[\r\n]+/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 8 || line.length > 150) continue;
    // Must be mostly words (letters + spaces > 55%)
    const wordChars = (line.match(/[a-zA-Z ]/g) ?? []).length;
    if (wordChars / line.length < 0.55) continue;
    // Skip shell prompt lines
    if (/^[\$%>#!]/.test(line)) continue;
    // Skip file/URL paths
    if (/^[./~]/.test(line) || /^https?:\/\//.test(line)) continue;
    // Skip lines that are just one word (likely a command name)
    if (!/\s/.test(line)) continue;
    return line.slice(0, 60);
  }
  return null;
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
   * POST /api/terminal/:id/generate-topic - Extract a topic from session history
   */
  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/generate-topic', async (request, reply) => {
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

    const rawHistory = session.history.map((e) => e.text || '').join('');
    const plainText = stripAnsi(rawHistory);

    const topic = extractTopicFromText(plainText);
    if (!topic) {
      reply.code(400).send({ error: 'Could not extract a topic from session history' });
      return;
    }

    const updatedSession = await updateThreadMetadata(userId, request.params.id, {
      topic,
      topicAutoGenerated: true
    });

    reply.send({ topic, thread: updatedSession?.thread });
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
