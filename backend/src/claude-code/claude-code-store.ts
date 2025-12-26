import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeCodeSession } from './claude-code-types';

// Use process.cwd() which is the backend/ directory when running npm start
const DATA_DIR = join(process.cwd(), 'data');

function sanitizeId(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) {
    throw new Error(`Invalid ID: "${id}" - ID must contain alphanumeric characters or hyphens`);
  }
  return safeId;
}

function getUserClaudeCodeDir(userId: string): string {
  const safeUserId = sanitizeId(userId);
  return join(DATA_DIR, 'users', safeUserId, 'claude-code');
}

async function ensureUserClaudeCodeDir(userId: string): Promise<string> {
  const claudeCodeDir = getUserClaudeCodeDir(userId);
  if (!existsSync(claudeCodeDir)) {
    await mkdir(claudeCodeDir, { recursive: true });
  }
  return claudeCodeDir;
}

function getSessionFilePath(userId: string, sessionId: string): string {
  const safeSessionId = sanitizeId(sessionId);
  return join(getUserClaudeCodeDir(userId), `${safeSessionId}.json`);
}

export async function saveClaudeCodeSession(userId: string, session: ClaudeCodeSession): Promise<void> {
  await ensureUserClaudeCodeDir(userId);
  const filePath = getSessionFilePath(userId, session.id);
  try {
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to save Claude Code session ${session.id}:`, error);
    throw error;
  }
}

export async function loadClaudeCodeSession(userId: string, sessionId: string): Promise<ClaudeCodeSession | null> {
  const filePath = getSessionFilePath(userId, sessionId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as ClaudeCodeSession;
  } catch (error) {
    console.error(`Failed to load Claude Code session ${sessionId}:`, error);
    return null;
  }
}

export async function deleteClaudeCodeSession(userId: string, sessionId: string): Promise<void> {
  const filePath = getSessionFilePath(userId, sessionId);
  if (existsSync(filePath)) {
    try {
      await unlink(filePath);
    } catch (error) {
      console.error(`Failed to delete Claude Code session ${sessionId}:`, error);
    }
  }
}

export async function loadAllClaudeCodeSessions(userId: string): Promise<ClaudeCodeSession[]> {
  const claudeCodeDir = await ensureUserClaudeCodeDir(userId);

  try {
    const files = await readdir(claudeCodeDir);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    // Load all sessions in parallel for better performance
    const sessionPromises = jsonFiles.map((file) => {
      const sessionId = file.replace('.json', '');
      return loadClaudeCodeSession(userId, sessionId);
    });

    const loadedSessions = await Promise.all(sessionPromises);
    const sessions = loadedSessions.filter((s): s is ClaudeCodeSession => s !== null);

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  } catch (error) {
    console.error('Failed to load all Claude Code sessions:', error);
    return [];
  }
}
