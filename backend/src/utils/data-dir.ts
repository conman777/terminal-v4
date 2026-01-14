import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

/**
 * Resolve the base data directory for all persisted JSON/DB files.
 * Defaults to backend/data (relative to the project), but allows overrides via
 * TERMINAL_DATA_DIR or DATA_DIR.
 */
export function getDataDir(): string {
  const envDir = process.env.TERMINAL_DATA_DIR || process.env.DATA_DIR;
  return envDir ? path.resolve(envDir) : DEFAULT_DATA_DIR;
}

export function ensureDataDir(): string {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
