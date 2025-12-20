import type { FastifyInstance } from 'fastify';
import { createReadStream, statSync } from 'node:fs';
import { access, constants, realpath } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.map': 'application/json'
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

function normalizePathForPlatform(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithinBase(basePath: string, candidatePath: string): boolean {
  const baseNormalized = normalizePathForPlatform(resolve(basePath));
  const candidateNormalized = normalizePathForPlatform(resolve(candidatePath));

  if (candidateNormalized === baseNormalized) return true;

  const baseWithSep = baseNormalized.endsWith(sep) ? baseNormalized : baseNormalized + sep;
  return candidateNormalized.startsWith(baseWithSep);
}

let projectRootRealPathCache: string | null = null;
async function getProjectRootRealPath(): Promise<string> {
  if (projectRootRealPathCache) return projectRootRealPathCache;
  try {
    projectRootRealPathCache = await realpath(PROJECT_ROOT);
  } catch {
    projectRootRealPathCache = PROJECT_ROOT;
  }
  return projectRootRealPathCache;
}

async function resolvePathInProjectRoot(targetPath: string): Promise<string | null> {
  const resolvedTargetPath = resolve(targetPath);
  const baseRealPath = await getProjectRootRealPath();

  let targetRealPath: string;
  try {
    targetRealPath = await realpath(resolvedTargetPath);
  } catch {
    targetRealPath = resolvedTargetPath;
  }

  return isWithinBase(baseRealPath, targetRealPath) ? targetRealPath : null;
}

function sanitizePath(basePath: string, requestedPath: string): string | null {
  // Normalize and resolve the full path
  const normalizedRequest = normalize(requestedPath).replace(/^[/\\]+/, '');
  const fullPath = resolve(basePath, normalizedRequest);

  // Ensure the resolved path is within the base path
  const resolvedBase = resolve(basePath);
  if (!isWithinBase(resolvedBase, fullPath)) {
    return null;
  }

  return fullPath;
}

export async function registerPreviewRoutes(app: FastifyInstance): Promise<void> {
  // Serve static files from any directory
  // Usage: /api/preview?path=C:/path/to/folder&file=index.html
  app.get('/api/preview', async (request, reply) => {
    const query = request.query as { path?: string; file?: string };

    if (!query.path) {
      reply.code(400).send({ error: 'Missing "path" query parameter' });
      return;
    }

    const basePath = query.path;
    const filePath = query.file || 'index.html';

    // Sandboxing: base path must be inside the project root (prevents reading arbitrary files)
    const safeBasePath = await resolvePathInProjectRoot(basePath);
    if (!safeBasePath) {
      reply.code(403).send({ error: 'Access denied: base path is outside project root' });
      return;
    }

    // Sanitize the file path to prevent directory traversal
    const fullPath = sanitizePath(safeBasePath, filePath);
    if (!fullPath) {
      reply.code(403).send({ error: 'Access denied: path traversal detected' });
      return;
    }

    // Sandboxing: also prevent symlink escapes for the specific file path.
    const safeFullPath = await resolvePathInProjectRoot(fullPath);
    if (!safeFullPath) {
      reply.code(403).send({ error: 'Access denied: resolved path is outside project root' });
      return;
    }

    try {
      // Check if file exists and is readable
      await access(safeFullPath, constants.R_OK);

      const stat = statSync(safeFullPath);
      if (stat.isDirectory()) {
        // If it's a directory, try to serve index.html
        const indexPath = join(safeFullPath, 'index.html');
        try {
          await access(indexPath, constants.R_OK);
          const indexStat = statSync(indexPath);
          const mimeType = getMimeType(indexPath);

          reply.header('Content-Type', mimeType);
          reply.header('Content-Length', indexStat.size);
          reply.header('Cache-Control', 'no-cache');

          return reply.send(createReadStream(indexPath));
        } catch {
          reply.code(404).send({ error: 'index.html not found in directory' });
          return;
        }
      }

      const mimeType = getMimeType(safeFullPath);

      reply.header('Content-Type', mimeType);
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'no-cache');

      return reply.send(createReadStream(safeFullPath));
    } catch (error) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }
  });
}
