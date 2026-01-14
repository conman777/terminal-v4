import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalStreamEvent } from './terminal-types';
import { ensureDataDir } from '../utils/data-dir';

export interface PersistedSession {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  history: TerminalStreamEvent[];
}

// Stable base data directory (repo-relative or env override)
const DATA_DIR = ensureDataDir();

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

// Lightweight metadata index that survives session file corruption
// Stores just id -> title mapping for recovery purposes
interface SessionMetadataIndex {
  [sessionId: string]: {
    title: string;
    shell: string;
    cwd: string;
    createdAt: string;
  };
}

function getMetadataIndexPath(userId: string): string {
  const safeUserId = sanitizeId(userId);
  return join(DATA_DIR, 'users', safeUserId, 'sessions-metadata.json');
}

async function loadMetadataIndex(userId: string): Promise<SessionMetadataIndex> {
  const indexPath = getMetadataIndexPath(userId);
  if (!existsSync(indexPath)) {
    return {};
  }
  try {
    const data = await readFile(indexPath, 'utf-8');
    return JSON.parse(data) as SessionMetadataIndex;
  } catch {
    return {};
  }
}

async function saveMetadataIndex(userId: string, index: SessionMetadataIndex): Promise<void> {
  const indexPath = getMetadataIndexPath(userId);
  const parentDir = join(DATA_DIR, 'users', sanitizeId(userId));
  const tempPath = `${indexPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    // Ensure parent directory exists
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true });
    }
    await writeFile(tempPath, JSON.stringify(index, null, 2), 'utf-8');
    await rename(tempPath, indexPath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) await unlink(tempPath);
    } catch {}
    // Non-fatal - index is just for recovery
    console.error('Failed to save metadata index:', error);
  }
}

export async function updateSessionMetadata(
  userId: string,
  sessionId: string,
  metadata: { title: string; shell: string; cwd: string; createdAt: string }
): Promise<void> {
  const index = await loadMetadataIndex(userId);
  index[sessionId] = metadata;
  await saveMetadataIndex(userId, index);
}

export async function getSessionMetadata(
  userId: string,
  sessionId: string
): Promise<{ title: string; shell: string; cwd: string; createdAt: string } | null> {
  const index = await loadMetadataIndex(userId);
  return index[sessionId] || null;
}

export async function deleteSessionMetadata(userId: string, sessionId: string): Promise<void> {
  const index = await loadMetadataIndex(userId);
  delete index[sessionId];
  await saveMetadataIndex(userId, index);
}

export async function saveSession(userId: string, session: PersistedSession): Promise<void> {
  await ensureUserSessionsDir(userId);
  const filePath = getSessionFilePath(userId, session.id);
  // Use unique temp file to prevent corruption from concurrent saves
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
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
      console.warn(`Moving corrupt empty session file to backup: ${sessionId}`);
      await moveToBackup(filePath, sessionId);
      return null;
    }

    const data = await readFile(filePath, 'utf-8');
    if (!data || data.trim() === '') {
      console.warn(`Moving corrupt empty session file to backup: ${sessionId}`);
      await moveToBackup(filePath, sessionId);
      return null;
    }
    return JSON.parse(data) as PersistedSession;
  } catch (error) {
    console.error(`Failed to load session ${sessionId}, moving corrupt file to backup:`, error);
    // Move corrupt file to backup so user can potentially recover data
    try {
      await moveToBackup(filePath, sessionId);
    } catch {}
    return null;
  }
}

async function moveToBackup(filePath: string, sessionId: string): Promise<void> {
  const backupDir = join(DATA_DIR, 'corrupt-sessions');
  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `${sessionId}-${timestamp}.json`);
  try {
    await rename(filePath, backupPath);
    console.log(`Moved corrupt session ${sessionId} to ${backupPath}`);
  } catch (error) {
    // If rename fails (e.g., different filesystem), try copy + delete
    const data = await readFile(filePath);
    await writeFile(backupPath, data);
    await unlink(filePath);
    console.log(`Copied corrupt session ${sessionId} to ${backupPath}`);
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
