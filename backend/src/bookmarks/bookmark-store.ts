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
const BOOKMARKS_FILE = join(DATA_DIR, 'bookmarks.json');

let bookmarks: Bookmark[] = [];

// Simple async lock to prevent concurrent modifications
let writeLock: Promise<void> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousLock = writeLock;
  let releaseLock: () => void;
  writeLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  await previousLock;
  try {
    return await fn();
  } finally {
    releaseLock!();
  }
}

async function ensureDataDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

export async function loadBookmarks(): Promise<Bookmark[]> {
  await ensureDataDir();

  if (!existsSync(BOOKMARKS_FILE)) {
    bookmarks = [];
    await saveBookmarks();
    return bookmarks;
  }

  try {
    const data = await readFile(BOOKMARKS_FILE, 'utf-8');
    bookmarks = JSON.parse(data);
    return bookmarks;
  } catch (error) {
    console.error('Failed to load bookmarks:', error);
    bookmarks = [];
    return bookmarks;
  }
}

async function saveBookmarks(): Promise<void> {
  try {
    await writeFile(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save bookmarks:', error);
    throw error;
  }
}

export function getAllBookmarks(): Bookmark[] {
  return bookmarks;
}

export async function createBookmark(name: string, command: string, category: string): Promise<Bookmark> {
  return withWriteLock(async () => {
    const newBookmark: Bookmark = {
      id: randomUUID(),
      name,
      command,
      category,
      createdAt: new Date().toISOString()
    };

    bookmarks.push(newBookmark);
    await saveBookmarks();
    return newBookmark;
  });
}

export async function updateBookmark(
  id: string,
  updates: { name?: string; command?: string; category?: string }
): Promise<Bookmark | null> {
  return withWriteLock(async () => {
    const index = bookmarks.findIndex((b) => b.id === id);

    if (index === -1) {
      return null;
    }

    bookmarks[index] = {
      ...bookmarks[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await saveBookmarks();
    return bookmarks[index];
  });
}

export async function deleteBookmark(id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const originalLength = bookmarks.length;
    bookmarks = bookmarks.filter((b) => b.id !== id);

    if (bookmarks.length === originalLength) {
      return false;
    }

    await saveBookmarks();
    return true;
  });
}
