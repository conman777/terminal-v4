import type { FastifyInstance } from 'fastify';
import { readdir, stat, mkdir, rm, rename } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Extract } from 'unzipper';
import {
  resolvePathInUserHome,
  USER_HOME,
  sanitizeFilename
} from '../utils/path-security.js';
import {
  fileListQuerySchema,
  fileMkdirRequestSchema,
  fileDeleteRequestSchema,
  fileRenameRequestSchema,
  fileUnzipRequestSchema
} from './schemas.js';

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB

interface FileItem {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // List directory contents
  app.get('/api/files/list', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const query = fileListQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: 'Invalid query', details: query.error.flatten() });
      return;
    }

    const requestedPath = query.data.path || '~';
    const safePath = await resolvePathInUserHome(requestedPath);

    if (!safePath) {
      reply.code(403).send({ error: 'Access denied: path is outside home directory' });
      return;
    }

    try {
      const entries = await readdir(safePath, { withFileTypes: true });
      const items: FileItem[] = [];

      for (const entry of entries) {
        // Skip hidden files (starting with .)
        if (entry.name.startsWith('.')) continue;

        try {
          const fullPath = join(safePath, entry.name);
          const stats = await stat(fullPath);

          items.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime.toISOString()
          });
        } catch {
          // Skip files we can't stat (permission issues, etc.)
        }
      }

      // Sort: directories first, then alphabetically
      items.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      // Convert path back to ~ notation for display
      const displayPath = safePath.replace(USER_HOME, '~');

      reply.send({ path: displayPath, items });
    } catch (error) {
      reply.code(500).send({ error: 'Failed to list directory', message: (error as Error).message });
    }
  });

  // Create directory
  app.post('/api/files/mkdir', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const body = fileMkdirRequestSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400).send({ error: 'Invalid request', details: body.error.flatten() });
      return;
    }

    const safePath = await resolvePathInUserHome(body.data.path);
    if (!safePath) {
      reply.code(403).send({ error: 'Access denied: path is outside home directory' });
      return;
    }

    try {
      await mkdir(safePath, { recursive: true });
      reply.code(201).send({ success: true, path: safePath.replace(USER_HOME, '~') });
    } catch (error) {
      reply.code(500).send({ error: 'Failed to create directory', message: (error as Error).message });
    }
  });

  // Upload file(s)
  app.post('/api/files/upload', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const parts = request.parts();
    let destinationPath = '~';
    const uploadedFiles: string[] = [];

    try {
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'path') {
          destinationPath = part.value as string;
        } else if (part.type === 'file') {
          const safeDest = await resolvePathInUserHome(destinationPath);
          if (!safeDest) {
            reply.code(403).send({ error: 'Access denied: destination is outside home directory' });
            return;
          }

          const safeFilename = sanitizeFilename(part.filename);
          if (!safeFilename) {
            reply.code(400).send({ error: 'Invalid filename' });
            return;
          }

          const filePath = join(safeDest, safeFilename);

          // Check file size limit
          let totalSize = 0;
          const writeStream = createWriteStream(filePath);

          try {
            for await (const chunk of part.file) {
              totalSize += chunk.length;
              if (totalSize > MAX_UPLOAD_SIZE) {
                writeStream.destroy();
                await rm(filePath, { force: true });
                reply.code(413).send({ error: 'File too large', maxSize: MAX_UPLOAD_SIZE });
                return;
              }
              writeStream.write(chunk);
            }
            writeStream.end();

            // Wait for write to complete
            await new Promise<void>((resolve, reject) => {
              writeStream.on('finish', resolve);
              writeStream.on('error', reject);
            });

            uploadedFiles.push(filePath.replace(USER_HOME, '~'));
          } catch (error) {
            writeStream.destroy();
            await rm(filePath, { force: true }).catch(() => {});
            throw error;
          }
        }
      }

      reply.code(201).send({ success: true, files: uploadedFiles });
    } catch (error) {
      reply.code(500).send({ error: 'Upload failed', message: (error as Error).message });
    }
  });

  // Download file
  app.get('/api/files/download', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const query = fileListQuerySchema.safeParse(request.query);
    if (!query.success || !query.data.path) {
      reply.code(400).send({ error: 'path is required' });
      return;
    }

    const safePath = await resolvePathInUserHome(query.data.path);
    if (!safePath) {
      reply.code(403).send({ error: 'Access denied: path is outside home directory' });
      return;
    }

    try {
      const stats = await stat(safePath);
      if (stats.isDirectory()) {
        reply.code(400).send({ error: 'Cannot download a directory' });
        return;
      }

      const filename = basename(safePath);
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', stats.size);

      const stream = createReadStream(safePath);
      return reply.send(stream);
    } catch (error) {
      reply.code(404).send({ error: 'File not found', message: (error as Error).message });
    }
  });

  // Delete file or directory
  app.delete('/api/files/delete', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const body = fileDeleteRequestSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400).send({ error: 'Invalid request', details: body.error.flatten() });
      return;
    }

    const safePath = await resolvePathInUserHome(body.data.path);
    if (!safePath) {
      reply.code(403).send({ error: 'Access denied: path is outside home directory' });
      return;
    }

    // Prevent deleting home directory itself
    if (safePath === USER_HOME) {
      reply.code(403).send({ error: 'Cannot delete home directory' });
      return;
    }

    try {
      await rm(safePath, { recursive: true, force: true });
      reply.code(204).send();
    } catch (error) {
      reply.code(500).send({ error: 'Failed to delete', message: (error as Error).message });
    }
  });

  // Rename/move file or directory
  app.post('/api/files/rename', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const body = fileRenameRequestSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400).send({ error: 'Invalid request', details: body.error.flatten() });
      return;
    }

    const safeOldPath = await resolvePathInUserHome(body.data.oldPath);
    const safeNewPath = await resolvePathInUserHome(body.data.newPath);

    if (!safeOldPath || !safeNewPath) {
      reply.code(403).send({ error: 'Access denied: path is outside home directory' });
      return;
    }

    try {
      await rename(safeOldPath, safeNewPath);
      reply.send({ success: true, path: safeNewPath.replace(USER_HOME, '~') });
    } catch (error) {
      reply.code(500).send({ error: 'Failed to rename', message: (error as Error).message });
    }
  });

  // Extract zip file
  app.post('/api/files/unzip', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const body = fileUnzipRequestSchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400).send({ error: 'Invalid request', details: body.error.flatten() });
      return;
    }

    const safeZipPath = await resolvePathInUserHome(body.data.zipPath);
    if (!safeZipPath) {
      reply.code(403).send({ error: 'Access denied: zip path is outside home directory' });
      return;
    }

    // Default extract to same directory as zip file
    const extractTo = body.data.extractTo || dirname(body.data.zipPath);
    const safeExtractPath = await resolvePathInUserHome(extractTo);

    if (!safeExtractPath) {
      reply.code(403).send({ error: 'Access denied: extract path is outside home directory' });
      return;
    }

    try {
      // Check if file exists and is a zip
      const stats = await stat(safeZipPath);
      if (stats.isDirectory()) {
        reply.code(400).send({ error: 'Path is a directory, not a zip file' });
        return;
      }

      // Extract the zip
      await pipeline(
        createReadStream(safeZipPath),
        Extract({ path: safeExtractPath })
      );

      reply.send({ success: true, extractedTo: safeExtractPath.replace(USER_HOME, '~') });
    } catch (error) {
      reply.code(500).send({ error: 'Failed to extract zip', message: (error as Error).message });
    }
  });

  // Upload screenshot for terminal paste
  const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024; // 10MB
  const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];

  app.post('/api/files/screenshot', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const parts = request.parts();
    let imageFile: { data: Buffer; mimetype: string } | null = null;

    try {
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'image') {
          // Validate MIME type
          if (!ALLOWED_IMAGE_TYPES.includes(part.mimetype)) {
            reply.code(400).send({
              error: 'Invalid file type',
              message: `Allowed types: ${ALLOWED_IMAGE_TYPES.join(', ')}`
            });
            return;
          }

          // Collect file data with size check
          const chunks: Buffer[] = [];
          let totalSize = 0;

          for await (const chunk of part.file) {
            totalSize += chunk.length;
            if (totalSize > MAX_SCREENSHOT_SIZE) {
              reply.code(413).send({
                error: 'File too large',
                maxSize: MAX_SCREENSHOT_SIZE,
                message: 'Maximum screenshot size is 10MB'
              });
              return;
            }
            chunks.push(chunk);
          }

          imageFile = {
            data: Buffer.concat(chunks),
            mimetype: part.mimetype
          };
        }
      }

      if (!imageFile) {
        reply.code(400).send({ error: 'No image file provided' });
        return;
      }

      // Create screenshots directory if it doesn't exist
      const screenshotsDir = join(USER_HOME, 'screenshots');
      await mkdir(screenshotsDir, { recursive: true });

      // Generate filename with timestamp
      const ext = imageFile.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : imageFile.mimetype.split('/')[1];
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `screenshot-${timestamp}.${ext}`;
      const filePath = join(screenshotsDir, filename);

      // Write file
      const writeStream = createWriteStream(filePath);
      writeStream.write(imageFile.data);
      writeStream.end();

      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const displayPath = `~/screenshots/${filename}`;
      reply.code(201).send({ success: true, path: displayPath });
    } catch (error) {
      reply.code(500).send({ error: 'Screenshot upload failed', message: (error as Error).message });
    }
  });
}
