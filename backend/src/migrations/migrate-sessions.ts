/**
 * One-time migration script to move orphaned terminal sessions
 * from the old location (/data/sessions/) to the new user-specific
 * location (/data/users/{userId}/sessions/).
 *
 * This handles sessions created before the user authentication system
 * was added (Dec 21, 2025).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabase } from '../database/db.js';
import { ensureDataDir } from '../utils/data-dir.js';

const DATA_DIR = ensureDataDir();
const OLD_SESSIONS_DIR = join(DATA_DIR, 'sessions');

interface User {
  id: string;
  username: string;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, '');
}

function getUserSessionsDir(userId: string): string {
  const safeUserId = sanitizeId(userId);
  return join(DATA_DIR, 'users', safeUserId, 'sessions');
}

function ensureUserSessionsDir(userId: string): string {
  const sessionsDir = getUserSessionsDir(userId);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }
  return sessionsDir;
}

function getAllUsers(): User[] {
  const db = getDatabase();
  return db.prepare('SELECT id, username FROM users').all() as User[];
}

export async function migrateOrphanedSessions(): Promise<void> {
  // Check if old sessions directory exists
  if (!existsSync(OLD_SESSIONS_DIR)) {
    console.log('[Migration] No old sessions directory found, skipping migration');
    return;
  }

  // Get all JSON files in old directory
  const files = readdirSync(OLD_SESSIONS_DIR).filter(f => f.endsWith('.json'));

  if (files.length === 0) {
    console.log('[Migration] Old sessions directory is empty, skipping migration');
    return;
  }

  console.log(`[Migration] Found ${files.length} session files in old location`);

  // Get all users from database
  const users = getAllUsers();

  if (users.length === 0) {
    console.log('[Migration] No users found in database, cannot migrate sessions');
    return;
  }

  // Use the first user (typically the only one in single-user setups)
  const targetUser = users[0];
  console.log(`[Migration] Migrating sessions to user: ${targetUser.username} (${targetUser.id})`);

  // Ensure user's sessions directory exists
  const targetDir = ensureUserSessionsDir(targetUser.id);

  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const file of files) {
    const sessionId = file.replace('.json', '');
    const oldPath = join(OLD_SESSIONS_DIR, file);
    const newPath = join(targetDir, file);

    try {
      // Check if session already exists in destination
      if (existsSync(newPath)) {
        console.log(`[Migration] Skipping ${sessionId} - already exists in destination`);
        skippedCount++;
        continue;
      }

      // Read and validate the session file
      const content = readFileSync(oldPath, 'utf-8');
      if (!content || content.trim() === '') {
        console.log(`[Migration] Skipping ${sessionId} - empty file`);
        skippedCount++;
        continue;
      }

      // Parse to validate JSON structure
      const session = JSON.parse(content);
      if (!session.id || !session.title) {
        console.log(`[Migration] Skipping ${sessionId} - invalid structure`);
        skippedCount++;
        continue;
      }

      // Copy to new location
      writeFileSync(newPath, content, 'utf-8');
      console.log(`[Migration] Migrated: ${session.title} (${sessionId})`);
      migratedCount++;
    } catch (error) {
      console.error(`[Migration] Error migrating ${sessionId}:`, error);
      errorCount++;
    }
  }

  console.log(`[Migration] Complete: ${migratedCount} migrated, ${skippedCount} skipped, ${errorCount} errors`);

  // Rename old directory as backup (only if we successfully migrated some files)
  if (migratedCount > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(DATA_DIR, `sessions-migrated-${timestamp}`);
    try {
      renameSync(OLD_SESSIONS_DIR, backupDir);
      console.log(`[Migration] Old sessions directory backed up to: ${backupDir}`);
    } catch (error) {
      console.error('[Migration] Failed to rename old sessions directory:', error);
    }
  }
}
