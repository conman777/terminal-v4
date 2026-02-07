import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { ensureDataDir } from '../utils/data-dir';

const DATA_DIR = ensureDataDir();
const DB_PATH = path.join(DATA_DIR, 'terminal.db');

export function initDatabase(): Database.Database {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log(`[database] Using data dir: ${DATA_DIR}`);
  console.log(`[database] Using db path: ${DB_PATH}`);

  const db = new Database(DB_PATH);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Run migrations
  runMigrations(db);

  return db;
}

function runMigrations(db: Database.Database): void {
  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const migrations: { name: string; sql: string }[] = [
    {
      name: '001_create_users',
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      `
    },
    {
      name: '002_create_refresh_tokens',
      sql: `
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
      `
    },
    {
      name: '003_create_user_settings',
      sql: `
        CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY,
          groq_api_key TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `
    },
    {
      name: '004_add_preview_url_to_settings',
      sql: `
        ALTER TABLE user_settings ADD COLUMN preview_url TEXT;
      `
    },
    {
      name: '005_add_ui_preferences_to_settings',
      sql: `
        ALTER TABLE user_settings ADD COLUMN terminal_font_size INTEGER DEFAULT 14;
        ALTER TABLE user_settings ADD COLUMN sidebar_collapsed INTEGER DEFAULT 0;
      `
    },
    {
      name: '006_add_terminal_webgl_enabled',
      sql: `
        ALTER TABLE user_settings ADD COLUMN terminal_webgl_enabled INTEGER DEFAULT 1;
      `
    },
    {
      name: '007_add_theme',
      sql: `
        ALTER TABLE user_settings ADD COLUMN theme TEXT DEFAULT 'dark';
      `
    }
  ];

  const appliedMigrations = new Set(
    db.prepare('SELECT name FROM migrations').all().map((row: any) => row.name)
  );

  for (const migration of migrations) {
    if (!appliedMigrations.has(migration.name)) {
      console.log(`Running migration: ${migration.name}`);
      db.exec(migration.sql);
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        new Date().toISOString()
      );
    }
  }
}
