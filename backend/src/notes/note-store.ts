import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDataDir } from '../utils/data-dir';

export interface Note {
  id: string;
  title: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt?: string;
}

// Stable base data directory (repo-relative or env override)
const DATA_DIR = ensureDataDir();

// Per-user note cache
const userNotes = new Map<string, Note[]>();

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

function getNotesFilePath(userId: string): string {
  return join(getUserDataDir(userId), 'notes.json');
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

export async function loadNotes(userId: string): Promise<Note[]> {
  await ensureUserDataDir(userId);

  const filePath = getNotesFilePath(userId);
  if (!existsSync(filePath)) {
    userNotes.set(userId, []);
    return [];
  }

  try {
    const data = await readFile(filePath, 'utf-8');
    const notes = JSON.parse(data) as Note[];
    userNotes.set(userId, notes);
    return notes;
  } catch (error) {
    console.error(`Failed to load notes for user ${userId}:`, error);
    userNotes.set(userId, []);
    return [];
  }
}

async function saveNotes(userId: string): Promise<void> {
  const notes = userNotes.get(userId) || [];
  const filePath = getNotesFilePath(userId);
  try {
    await writeFile(filePath, JSON.stringify(notes, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to save notes for user ${userId}:`, error);
    throw error;
  }
}

export function getAllNotes(userId: string): Note[] {
  return userNotes.get(userId) || [];
}

export async function createNote(userId: string, title: string, content: string, category: string): Promise<Note> {
  return withUserWriteLock(userId, async () => {
    const notes = userNotes.get(userId) || [];
    const newNote: Note = {
      id: randomUUID(),
      title,
      content,
      category,
      createdAt: new Date().toISOString()
    };

    notes.push(newNote);
    userNotes.set(userId, notes);
    await saveNotes(userId);
    return newNote;
  });
}

export async function updateNote(
  userId: string,
  id: string,
  updates: { title?: string; content?: string; category?: string }
): Promise<Note | null> {
  return withUserWriteLock(userId, async () => {
    const notes = userNotes.get(userId) || [];
    const index = notes.findIndex((n) => n.id === id);

    if (index === -1) {
      return null;
    }

    notes[index] = {
      ...notes[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    userNotes.set(userId, notes);
    await saveNotes(userId);
    return notes[index];
  });
}

export async function deleteNote(userId: string, id: string): Promise<boolean> {
  return withUserWriteLock(userId, async () => {
    const notes = userNotes.get(userId) || [];
    const originalLength = notes.length;
    const filtered = notes.filter((n) => n.id !== id);

    if (filtered.length === originalLength) {
      return false;
    }

    userNotes.set(userId, filtered);
    await saveNotes(userId);
    return true;
  });
}
