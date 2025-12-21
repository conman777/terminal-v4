import Database from 'better-sqlite3';
import { initDatabase } from './init.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    db = initDatabase();
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
