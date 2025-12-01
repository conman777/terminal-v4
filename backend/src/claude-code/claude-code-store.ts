import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeCodeSession } from './claude-code-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');
const CLAUDE_CODE_DIR = join(DATA_DIR, 'claude-code');

async function ensureClaudeCodeDir(): Promise<void> {
  if (!existsSync(CLAUDE_CODE_DIR)) {
    await mkdir(CLAUDE_CODE_DIR, { recursive: true });
  }
}

function getSessionFilePath(sessionId: string): string {
  // Sanitize session ID to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9-]/g, '');
  return join(CLAUDE_CODE_DIR, `${safeId}.json`);
}

export async function saveClaudeCodeSession(session: ClaudeCodeSession): Promise<void> {
  await ensureClaudeCodeDir();
  const filePath = getSessionFilePath(session.id);
  try {
    await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to save Claude Code session ${session.id}:`, error);
    throw error;
  }
}

export async function loadClaudeCodeSession(sessionId: string): Promise<ClaudeCodeSession | null> {
  const filePath = getSessionFilePath(sessionId);
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

export async function deleteClaudeCodeSession(sessionId: string): Promise<void> {
  const filePath = getSessionFilePath(sessionId);
  if (existsSync(filePath)) {
    try {
      await unlink(filePath);
    } catch (error) {
      console.error(`Failed to delete Claude Code session ${sessionId}:`, error);
    }
  }
}

export async function loadAllClaudeCodeSessions(): Promise<ClaudeCodeSession[]> {
  await ensureClaudeCodeDir();

  try {
    const files = await readdir(CLAUDE_CODE_DIR);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    // Load all sessions in parallel for better performance
    const sessionPromises = jsonFiles.map((file) => {
      const sessionId = file.replace('.json', '');
      return loadClaudeCodeSession(sessionId);
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

