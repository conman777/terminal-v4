import type { FastifyInstance } from 'fastify';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { resolvePathAnywhere } from '../utils/path-security.js';

// Files/directories to exclude from WebContainer mount
const EXCLUDED_PATTERNS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.env.local',
  '.env.*.local',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.lock'
];

// Maximum file size to include (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

// Maximum total project size (50MB)
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

// Binary file extensions to skip
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.flac',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib',
  '.wasm'
]);

function shouldExclude(name: string): boolean {
  // Check exact matches
  if (EXCLUDED_PATTERNS.includes(name)) return true;

  // Check if it's a dotfile (except some allowed ones)
  if (name.startsWith('.') && !name.startsWith('.env') && name !== '.gitignore' && name !== '.npmrc') {
    return true;
  }

  // Check wildcard patterns
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      if (name.endsWith(suffix)) return true;
    }
  }

  return false;
}

function isBinaryFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

interface FileTree {
  [key: string]: {
    file?: { contents: string };
    directory?: FileTree;
  };
}

async function buildFileTree(
  dirPath: string,
  basePath: string,
  currentSize: { value: number }
): Promise<FileTree> {
  const tree: FileTree = {};
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldExclude(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);
    const relativePath = relative(basePath, fullPath);

    try {
      const stats = await stat(fullPath);

      if (entry.isDirectory()) {
        const subTree = await buildFileTree(fullPath, basePath, currentSize);
        if (Object.keys(subTree).length > 0) {
          tree[entry.name] = { directory: subTree };
        }
      } else if (entry.isFile()) {
        // Skip binary files
        if (isBinaryFile(fullPath)) continue;

        // Skip files that are too large
        if (stats.size > MAX_FILE_SIZE) {
          console.log(`[WebContainer] Skipping large file: ${relativePath} (${stats.size} bytes)`);
          continue;
        }

        // Check total size limit
        if (currentSize.value + stats.size > MAX_TOTAL_SIZE) {
          console.log(`[WebContainer] Total size limit reached, skipping: ${relativePath}`);
          continue;
        }

        try {
          const contents = await readFile(fullPath, 'utf-8');
          currentSize.value += stats.size;
          tree[entry.name] = { file: { contents } };
        } catch (err) {
          // Skip files that can't be read as text
          console.log(`[WebContainer] Skipping unreadable file: ${relativePath}`);
        }
      }
    } catch (err) {
      // Skip files we can't stat
      console.log(`[WebContainer] Skipping inaccessible: ${relativePath}`);
    }
  }

  return tree;
}

export async function registerWebContainerRoutes(app: FastifyInstance): Promise<void> {
  // Get project files for WebContainer mounting
  app.get('/api/webcontainer/files', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const query = request.query as { path?: string };
    const requestedPath = query.path;

    if (!requestedPath) {
      reply.code(400).send({ error: 'Missing path parameter' });
      return;
    }

    try {
      const safePath = await resolvePathAnywhere(requestedPath);

      // Verify it's a directory
      const stats = await stat(safePath);
      if (!stats.isDirectory()) {
        reply.code(400).send({ error: 'Path is not a directory' });
        return;
      }

      // Check for package.json to ensure it's a Node.js project
      try {
        await stat(join(safePath, 'package.json'));
      } catch {
        reply.code(400).send({
          error: 'Not a Node.js project',
          message: 'No package.json found in the specified directory'
        });
        return;
      }

      const currentSize = { value: 0 };
      const files = await buildFileTree(safePath, safePath, currentSize);

      reply.send({
        files,
        stats: {
          totalSize: currentSize.value,
          fileCount: countFiles(files)
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(500).send({ error: 'Failed to read project files', message });
    }
  });
}

function countFiles(tree: FileTree): number {
  let count = 0;
  for (const value of Object.values(tree)) {
    if (value.file) {
      count++;
    } else if (value.directory) {
      count += countFiles(value.directory);
    }
  }
  return count;
}
