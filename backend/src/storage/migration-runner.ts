/**
 * Migration Runner
 *
 * Manages schema version tracking and migration execution for storage layer.
 * Migrations are SQL files in the migrations directory.
 */

import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Initialize migrations table
 */
function initMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

/**
 * Get list of applied migrations
 */
function getAppliedMigrations(db: Database.Database): Set<string> {
  const stmt = db.prepare('SELECT name FROM storage_migrations');
  const rows = stmt.all() as Array<{ name: string }>;
  return new Set(rows.map(row => row.name));
}

/**
 * Load migration files from disk
 */
function loadMigrationFiles(migrationsDir: string): Migration[] {
  const migrations: Migration[] = [];

  if (!fs.existsSync(migrationsDir)) {
    console.warn(`[migration-runner] Migrations directory not found: ${migrationsDir}`);
    return migrations;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort(); // Ensure migrations run in order

  for (const file of files) {
    const match = file.match(/^(\d+)-(.+)\.sql$/);
    if (!match) {
      console.warn(`[migration-runner] Skipping invalid migration file: ${file}`);
      continue;
    }

    const id = parseInt(match[1], 10);
    const name = match[2];
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    migrations.push({ id, name: file, sql });
  }

  return migrations;
}

/**
 * Apply a migration
 */
function applyMigration(db: Database.Database, migration: Migration): void {
  console.log(`[migration-runner] Applying migration: ${migration.name}`);

  const applyTx = db.transaction(() => {
    // Execute migration SQL
    db.exec(migration.sql);

    // Record migration as applied
    db.prepare('INSERT INTO storage_migrations (id, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.id, migration.name, new Date().toISOString());
  });

  applyTx();
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database.Database, migrationsDir?: string): void {
  const dir = migrationsDir || path.join(__dirname, 'migrations');

  // Initialize migrations tracking table
  initMigrationsTable(db);

  // Get applied migrations
  const appliedMigrations = getAppliedMigrations(db);

  // Load migration files
  const migrations = loadMigrationFiles(dir);

  // Apply pending migrations
  let appliedCount = 0;
  for (const migration of migrations) {
    if (!appliedMigrations.has(migration.name)) {
      applyMigration(db, migration);
      appliedCount++;
    }
  }

  if (appliedCount > 0) {
    console.log(`[migration-runner] Applied ${appliedCount} migration(s)`);
  } else {
    console.log('[migration-runner] All migrations up to date');
  }
}

/**
 * Get current schema version
 */
export function getSchemaVersion(db: Database.Database): number {
  try {
    const stmt = db.prepare('SELECT MAX(id) as version FROM storage_migrations');
    const row = stmt.get() as { version: number | null };
    return row.version || 0;
  } catch (err) {
    // Table doesn't exist yet
    return 0;
  }
}
