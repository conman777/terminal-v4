import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Define the root directory of the project for sandboxing filesystem operations
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * Normalize path for platform-specific comparison (case-insensitive on Windows)
 */
export function normalizePathForPlatform(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Check if a candidate path is within or equal to a base path
 */
export function isWithinBase(basePath: string, candidatePath: string): boolean {
  const baseNormalized = normalizePathForPlatform(resolve(basePath));
  const candidateNormalized = normalizePathForPlatform(resolve(candidatePath));

  if (candidateNormalized === baseNormalized) return true;

  const baseWithSep = baseNormalized.endsWith(sep) ? baseNormalized : baseNormalized + sep;
  return candidateNormalized.startsWith(baseWithSep);
}

let projectRootRealPathCache: string | null = null;

/**
 * Get the real path of PROJECT_ROOT (resolving symlinks)
 */
export async function getProjectRootRealPath(): Promise<string> {
  if (projectRootRealPathCache) return projectRootRealPathCache;
  try {
    projectRootRealPathCache = await realpath(PROJECT_ROOT);
  } catch {
    projectRootRealPathCache = PROJECT_ROOT;
  }
  return projectRootRealPathCache;
}

/**
 * Resolve a path and validate it's within PROJECT_ROOT
 * Returns the resolved path if valid, null if outside allowed boundaries
 */
export async function resolvePathInProjectRoot(targetPath: string): Promise<string | null> {
  const resolvedTargetPath = resolve(targetPath);
  const baseRealPath = await getProjectRootRealPath();

  let targetRealPath: string;
  try {
    targetRealPath = await realpath(resolvedTargetPath);
  } catch {
    // If the path doesn't exist yet we still want to validate containment based on the resolved path.
    targetRealPath = resolvedTargetPath;
  }

  return isWithinBase(baseRealPath, targetRealPath) ? targetRealPath : null;
}

/**
 * Validate that a path is within allowed boundaries
 * Throws an error if validation fails
 */
export async function validatePathSecurity(targetPath: string, description: string = 'path'): Promise<string> {
  const safePath = await resolvePathInProjectRoot(targetPath);
  if (!safePath) {
    throw new Error(`Access denied: ${description} is outside project root`);
  }
  return safePath;
}

/**
 * Validate UUID format for clientId and similar identifiers
 */
export function isValidUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Validate a simple identifier (alphanumeric with limited special chars)
 */
export function isValidIdentifier(value: string, maxLength: number = 64): boolean {
  if (!value || value.length > maxLength) return false;
  // Allow alphanumeric, hyphens, underscores
  return /^[a-zA-Z0-9_-]+$/.test(value);
}
