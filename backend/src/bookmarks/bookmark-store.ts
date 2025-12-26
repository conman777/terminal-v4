import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export interface Bookmark {
  id: string;
  name: string;
  command: string;
  category: string;
  createdAt: string;
  updatedAt?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');

// Per-user bookmark cache
const userBookmarks = new Map<string, Bookmark[]>();

// Per-user write locks
const userWriteLocks = new Map<string, Promise<void>>();

function sanitizeId(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safeId) {
    throw new Error(`Invalid ID: "${id}" - ID must contain alphanumeric characters or hyphens`);
  }
  return safeId;
}

function getUserDataDir(userId: string): string {
  const safeUserId = sanitizeId(userId);
  return join(DATA_DIR, 'users', safeUserId);
}

function getBookmarksFilePath(userId: string): string {
  return join(getUserDataDir(userId), 'bookmarks.json');
}

async function ensureUserDataDir(userId: string): Promise<void> {
  const userDir = getUserDataDir(userId);
  if (!existsSync(userDir)) {
    await mkdir(userDir, { recursive: true });
  }
}

async function withUserWriteLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previousLock = userWriteLocks.get(userId) || Promise.resolve();
  let releaseLock: () => void;
  const newLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  userWriteLocks.set(userId, newLock);
  await previousLock;
  try {
    return await fn();
  } finally {
    releaseLock!();
  }
}

// Default fixed bookmarks that all users get
const DEFAULT_BOOKMARKS: Omit<Bookmark, 'id' | 'createdAt'>[] = [
  {
    name: 'Claude Code (skip permissions)',
    command: 'claude --dangerously-skip-permissions',
    category: 'Claude'
  }
];

function createDefaultBookmarks(): Bookmark[] {
  return DEFAULT_BOOKMARKS.map(bookmark => ({
    ...bookmark,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  }));
}

export async function loadBookmarks(userId: string): Promise<Bookmark[]> {
  await ensureUserDataDir(userId);

  const filePath = getBookmarksFilePath(userId);
  if (!existsSync(filePath)) {
    const defaultBookmarks = createDefaultBookmarks();
    userBookmarks.set(userId, defaultBookmarks);
    await saveBookmarks(userId);
    return defaultBookmarks;
  }

  try {
    const data = await readFile(filePath, 'utf-8');
    let bookmarks = JSON.parse(data) as Bookmark[];

    // Add missing default bookmarks to existing users
    let needsSave = false;
    for (const defaultBookmark of DEFAULT_BOOKMARKS) {
      const exists = bookmarks.some(b => b.command === defaultBookmark.command);
      if (!exists) {
        bookmarks.push({
          ...defaultBookmark,
          id: randomUUID(),
          createdAt: new Date().toISOString()
        });
        needsSave = true;
      }
    }

    if (needsSave) {
      userBookmarks.set(userId, bookmarks);
      await saveBookmarks(userId);
    } else {
      userBookmarks.set(userId, bookmarks);
    }

    return bookmarks;
  } catch (error) {
    console.error(`Failed to load bookmarks for user ${userId}:`, error);
    userBookmarks.set(userId, []);
    return [];
  }
}

async function saveBookmarks(userId: string): Promise<void> {
  const bookmarks = userBookmarks.get(userId) || [];
  const filePath = getBookmarksFilePath(userId);
  try {
    await writeFile(filePath, JSON.stringify(bookmarks, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to save bookmarks for user ${userId}:`, error);
    throw error;
  }
}

export function getAllBookmarks(userId: string): Bookmark[] {
  return userBookmarks.get(userId) || [];
}

export async function createBookmark(userId: string, name: string, command: string, category: string): Promise<Bookmark> {
  return withUserWriteLock(userId, async () => {
    const bookmarks = userBookmarks.get(userId) || [];
    const newBookmark: Bookmark = {
      id: randomUUID(),
      name,
      command,
      category,
      createdAt: new Date().toISOString()
    };

    bookmarks.push(newBookmark);
    userBookmarks.set(userId, bookmarks);
    await saveBookmarks(userId);
    return newBookmark;
  });
}

export async function updateBookmark(
  userId: string,
  id: string,
  updates: { name?: string; command?: string; category?: string }
): Promise<Bookmark | null> {
  return withUserWriteLock(userId, async () => {
    const bookmarks = userBookmarks.get(userId) || [];
    const index = bookmarks.findIndex((b) => b.id === id);

    if (index === -1) {
      return null;
    }

    bookmarks[index] = {
      ...bookmarks[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    userBookmarks.set(userId, bookmarks);
    await saveBookmarks(userId);
    return bookmarks[index];
  });
}

export async function deleteBookmark(userId: string, id: string): Promise<boolean> {
  return withUserWriteLock(userId, async () => {
    const bookmarks = userBookmarks.get(userId) || [];
    const originalLength = bookmarks.length;
    const filtered = bookmarks.filter((b) => b.id !== id);

    if (filtered.length === originalLength) {
      return false;
    }

    userBookmarks.set(userId, filtered);
    await saveBookmarks(userId);
    return true;
  });
}
