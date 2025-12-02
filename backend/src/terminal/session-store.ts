import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');

async function ensureSessionsDir(): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
}

function getSessionFilePath(sessionId: string): string {
  // Sanitize session ID to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  return join(SESSIONS_DIR, `${safeId}.json`);
}

export async function saveSession(session: PersistedSession): Promise<void> {
  await ensureSessionsDir();
  const filePath = getSessionFilePath(session.id);
  try {
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to save session ${session.id}:`, error);
    throw error;
  }
}

export async function loadSession(sessionId: string): Promise<PersistedSession | null> {
  const filePath = getSessionFilePath(sessionId);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as PersistedSession;
  } catch (error) {
    console.error(`Failed to load session ${sessionId}:`, error);
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const filePath = getSessionFilePath(sessionId);
  if (existsSync(filePath)) {
    try {
      await unlink(filePath);
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
    }
  }
}

export async function loadAllSessions(): Promise<PersistedSession[]> {
  await ensureSessionsDir();

  try {
    const files = await readdir(SESSIONS_DIR);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    // Load all sessions in parallel for better performance
    const sessionPromises = jsonFiles.map((file) => {
      const sessionId = file.replace('.json', '');
      return loadSession(sessionId);
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
