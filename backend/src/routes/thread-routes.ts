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
import type { CoreRouteDependencies, TerminalIdParams } from './types';

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
 * Find the merge-base commit to diff against.
 * On feature branches, diffs against the default branch (origin/main or origin/master).
 * On main/master, returns null so we fall back to uncommitted changes only.
 */
async function findDiffBase(cwd: string): Promise<string | null> {
  try {
    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000 });
    const currentBranch = branchOut.trim();

    if (currentBranch === 'main' || currentBranch === 'master') return null;

    for (const candidate of ['origin/main', 'origin/master']) {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', candidate], { cwd, timeout: 5000 });
        const { stdout } = await execFileAsync('git', ['merge-base', candidate, 'HEAD'], { cwd, timeout: 5000 });
        return stdout.trim() || null;
      } catch {
        continue;
      }
    }
  } catch {
    // Not a git repo or other error
  }
  return null;
}

/** Parse git diff --stat summary line into linesAdded / linesRemoved */
function parseGitDiffStat(output: string): ThreadGitStats | null {
  const match = output.match(/(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/);
  if (match) {
    return { linesAdded: parseInt(match[1], 10), linesRemoved: parseInt(match[2], 10) };
  }
  const insertions = output.match(/(\d+) insertions?\(\+\)/);
  const deletions = output.match(/(\d+) deletions?\(-\)/);
  if (insertions || deletions) {
    return {
      linesAdded: insertions ? parseInt(insertions[1], 10) : 0,
      linesRemoved: deletions ? parseInt(deletions[1], 10) : 0
    };
  }
  return null;
}

/**
 * Get git diff stats for a session's working directory.
 * On feature branches: total branch diff vs default branch (origin/main or origin/master).
 * On main/master or if no remote: uncommitted changes only.
 */
async function getGitDiffStats(cwd: string): Promise<ThreadGitStats | null> {
  try {
    // Strategy 1: Branch-level diff against merge-base with default branch
    const diffBase = await findDiffBase(cwd);
    if (diffBase) {
      try {
        const { stdout } = await execFileAsync('git', ['diff', '--stat', diffBase], { cwd, timeout: 10000 });
        const stats = parseGitDiffStat(stdout);
        if (stats) return stats;
      } catch {
        // Fall through to next strategy
      }
    }

    // Strategy 2: Uncommitted changes (works on main or repos without remote)
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], { cwd, timeout: 10000 });
      return parseGitDiffStat(stdout);
    } catch {
      const { stdout } = await execFileAsync('git', ['diff', '--stat'], { cwd, timeout: 10000 });
      return parseGitDiffStat(stdout);
    }
  } catch {
    return null;
  }
}

/** Strip ANSI/VT escape sequences from terminal output */
function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')   // CSI sequences (colors, cursor moves)
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences (window title etc.)
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)/g, '')  // OSC terminated by ST
    .replace(/\x1b[^[\]]/g, '')                // other two-char escapes
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, ''); // non-printable control chars
}

function normalizeTopicLine(raw: string): string {
  return raw
    .replace(/\x1b\(B/g, '')
    .replace(/[·•]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyShellCommand(line: string): boolean {
  return /^(cd|ls|pwd|git|npm|pnpm|yarn|bun|node|python|pip|cargo|go|make|bash|sh|zsh|cat|rg|grep|sed|awk|jq|chmod|chown|mv|cp|rm|mkdir|touch)\b/i.test(line);
}

/**
 * Extract a short topic-like line from terminal text.
 * Prefer recent user intent / command lines and avoid wrapped fragments/tool chrome.
 */
function extractTopicFromText(plainText: string): string | null {
  const rawLines = plainText.split(/[\r\n]+/);
  const lines = rawLines.map(normalizeTopicLine).filter(Boolean);

  // Pass 1: prefer the most recent explicit user prompt line rendered by Claude/Codex CLI.
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const promptMatch = raw.match(/^[›>]\s*(.+)$/);
    if (!promptMatch) continue;
    const line = promptMatch[1].trim();
    if (line.length < 8 || line.length > 150) continue;
    if (!/\s/.test(line)) continue;
    if (isLikelyShellCommand(line)) continue;
    if (/^[./~]/.test(line) || /^https?:\/\//.test(line)) continue;
    return line.slice(0, 60);
  }

  const candidates: { line: string; score: number }[] = [];

  for (const raw of lines) {
    let line = raw;
    if (line.length < 8 || line.length > 150) continue;

    // Secondary pass can still use prompt lines, but strip marker.
    if (/^[›>]\s*/.test(line)) {
      line = line.replace(/^[›>]\s*/, '').trim();
    }

    // Must be mostly words (letters + spaces > 55%)
    const wordChars = (line.match(/[a-zA-Z ]/g) ?? []).length;
    if (wordChars / line.length < 0.55) continue;
    // Skip shell prompt / prompt+cwd lines
    if (/^[\$%#!]/.test(line)) continue;
    if (/^[^@\s]+@[^:\s]+:/.test(line)) continue;
    // Skip file/URL paths
    if (/^[./~]/.test(line) || /^https?:\/\//.test(line)) continue;
    // Skip lines that are just one word (likely a command name)
    if (!/\s/.test(line)) continue;
    if (isLikelyShellCommand(line)) continue;
    // Skip obvious tool/output chrome and wrapped fragments
    if (/^(Ran|Done!?|Next:|Building |Restarting |Worked for )/i.test(line)) continue;
    if (/^\+?\d+\s+more\s+(lines|tool uses)\b/i.test(line)) continue;
    if (/^\(?ctrl\+|^esc to /i.test(line)) continue;
    if (/^[a-z]/.test(line) && line.length < 28) continue; // likely wrapped continuation fragment
    if (/^[0-9]+\.\s/.test(line)) continue; // numbered list items from assistant output

    let score = 0;
    if (/[a-z]/.test(line[0] || '')) score += 2;
    if (/\b(fix|debug|investigate|add|update|rebuild|test|review|show)\b/i.test(line)) score += 3;
    if (line.length >= 20 && line.length <= 80) score += 2;
    if (!/[.:]\s*$/.test(line)) score += 1;

    candidates.push({ line, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].line.slice(0, 60);
}

export async function registerThreadRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
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
    if (session.thread) {
      deps.terminalManager.syncThreadMetadata(userId, request.params.id, session.thread);
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
    deps.terminalManager.syncThreadMetadata(userId, request.params.id, session.thread);

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

    const liveSnapshot = deps.terminalManager.getSession(userId, request.params.id, {
      includeHistory: true
    });
    const persistedSession = liveSnapshot ? null : await loadSession(userId, request.params.id);
    const history = liveSnapshot?.history || persistedSession?.history || [];

    if (!liveSnapshot && !persistedSession) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    const rawHistory = history.map((e) => e.text || '').join('');
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
    if (updatedSession?.thread) {
      deps.terminalManager.syncThreadMetadata(userId, request.params.id, updatedSession.thread);
    }

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
    deps.terminalManager.syncThreadMetadata(userId, request.params.id, session.thread);

    reply.send({ projectPath });
  });
}
