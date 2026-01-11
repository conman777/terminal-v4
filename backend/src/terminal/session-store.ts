import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalStreamEvent } from './terminal-types';

export interface PersistedSession {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  history: TerminalStreamEvent[];
}

// Use process.cwd() which is the backend/ directory when running npm start
const DATA_DIR = join(process.cwd(), 'data');

function sanitizeId(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) {
    throw new Error(`Invalid ID: "${id}" - ID must contain alphanumeric characters or hyphens`);
  }
  return safeId;
}

function getUserSessionsDir(userId: string): string {
  const safeUserId = sanitizeId(userId);
  return join(DATA_DIR, 'users', safeUserId, 'sessions');
}

async function ensureUserSessionsDir(userId: string): Promise<string> {
  const sessionsDir = getUserSessionsDir(userId);
  if (!existsSync(sessionsDir)) {
    await mkdir(sessionsDir, { recursive: true });
  }
  return sessionsDir;
}

function getSessionFilePath(userId: string, sessionId: string): string {
  const safeSessionId = sanitizeId(sessionId);
  return join(getUserSessionsDir(userId), `${safeSessionId}.json`);
}

export async function saveSession(userId: string, session: PersistedSession): Promise<void> {
  await ensureUserSessionsDir(userId);
  const filePath = getSessionFilePath(userId, session.id);
  const tempPath = `${filePath}.tmp`;
  try {
    // Write to temp file first, then atomic rename to prevent corruption
    await writeFile(tempPath, JSON.stringify(session, null, 2), 'utf-8');
    await rename(tempPath, filePath);
  } catch (error) {
    console.error(`Failed to save session ${session.id}:`, error);
    // Clean up temp file if it exists
    try {
      if (existsSync(tempPath)) await unlink(tempPath);
    } catch {}
    throw error;
  }
}

export async function loadSession(userId: string, sessionId: string): Promise<PersistedSession | null> {
  const filePath = getSessionFilePath(userId, sessionId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    // Check for corrupt 0-byte files
    const stats = statSync(filePath);
    if (stats.size === 0) {
      console.warn(`Deleting corrupt empty session file: ${sessionId}`);
      await unlink(filePath);
      return null;
    }

    const data = await readFile(filePath, 'utf-8');
    if (!data || data.trim() === '') {
      console.warn(`Deleting corrupt empty session file: ${sessionId}`);
      await unlink(filePath);
      return null;
    }
    return JSON.parse(data) as PersistedSession;
  } catch (error) {
    console.error(`Failed to load session ${sessionId}, deleting corrupt file:`, error);
    // Delete corrupt file so it doesn't block recovery
    try {
      await unlink(filePath);
    } catch {}
    return null;
  }
}

export async function deleteSession(userId: string, sessionId: string): Promise<void> {
  const filePath = getSessionFilePath(userId, sessionId);
  if (existsSync(filePath)) {
    try {
      await unlink(filePath);
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
    }
  }
}

export async function loadAllSessions(userId: string): Promise<PersistedSession[]> {
  const sessionsDir = await ensureUserSessionsDir(userId);

  try {
    const files = await readdir(sessionsDir);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    // Load all sessions in parallel for better performance
    const sessionPromises = jsonFiles.map((file) => {
      const sessionId = file.replace('.json', '');
      return loadSession(userId, sessionId);
    });

    const loadedSessions = await Promise.all(sessionPromises);
    const sessions = loadedSessions.filter((s): s is PersistedSession => s !== null);

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sessions;
  } catch (error) {
    console.error('Failed to load all sessions:', error);
    return [];
  }
}
