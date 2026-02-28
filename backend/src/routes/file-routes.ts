import type { FastifyInstance } from 'fastify';
import { readdir, stat, mkdir, rm, rename } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { Open } from 'unzipper';
import {
  USER_HOME,
  resolvePathAnywhere,
  sanitizeFilename,
  isWithinBase
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
  function formatDisplayPath(fullPath: string): string {
    return isWithinBase(USER_HOME, fullPath)
      ? fullPath.replace(USER_HOME, '~')
      : fullPath;
  }

  function sanitizeRelativePath(input: string): string | null {
    if (!input) return null;

    const normalized = input.replace(/\\/g, '/');
    if (isAbsolute(normalized) || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
      return null;
    }

    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    const sanitizedSegments: string[] = [];
    for (const segment of segments) {
      if (segment === '.' || segment === '..') return null;
      const sanitized = sanitizeFilename(segment);
      if (!sanitized) return null;
      sanitizedSegments.push(sanitized);
    }

    return sanitizedSegments.join('/');
  }

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
    const safePath = await resolvePathAnywhere(requestedPath);

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
      const displayPath = formatDisplayPath(safePath);

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

    const safePath = await resolvePathAnywhere(body.data.path);

    try {
      await mkdir(safePath, { recursive: true });
      reply.code(201).send({ success: true, path: formatDisplayPath(safePath) });
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
    let destinationPath: string | null = null;
    const pendingFiles: Array<{ tempPath: string; filename: string }> = [];
    const uploadedFiles: string[] = [];
    const tempDir = join(USER_HOME, '.terminal-upload-tmp');
    const alreadyMoved: string[] = [];

    try {
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'path') {
          destinationPath = part.value as string;
        } else if (part.type === 'file') {
          const targetPath = destinationPath ?? '~';
          const safeDest = await resolvePathAnywhere(targetPath);

          const safeRelativePath = sanitizeRelativePath(part.filename);
          if (!safeRelativePath) {
            reply.code(400).send({ error: 'Invalid filename' });
            return;
          }

          const finalPath = join(safeDest, safeRelativePath);
          if (!isWithinBase(safeDest, finalPath)) {
            reply.code(400).send({ error: 'Invalid filename' });
            return;
          }
          const shouldStage = destinationPath === null;
          const filePath = shouldStage ? join(tempDir, safeRelativePath) : finalPath;

          // Check file size limit
          let totalSize = 0;
          if (shouldStage) {
            await mkdir(tempDir, { recursive: true });
          }
          await mkdir(dirname(filePath), { recursive: true });
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

            if (shouldStage) {
              pendingFiles.push({ tempPath: filePath, filename: safeRelativePath });
            } else {
              uploadedFiles.push(formatDisplayPath(finalPath));
            }
          } catch (error) {
            writeStream.destroy();
            await rm(filePath, { force: true }).catch(() => {});
            throw error;
          }
        }
      }

      if (pendingFiles.length > 0) {
        const resolvedDest = await resolvePathAnywhere(destinationPath ?? '~');
        await mkdir(resolvedDest, { recursive: true });
        for (const staged of pendingFiles) {
          const finalPath = join(resolvedDest, staged.filename);
          if (!isWithinBase(resolvedDest, finalPath)) {
            for (const s of pendingFiles) {
              await rm(s.tempPath, { force: true }).catch(() => {});
            }
            reply.code(400).send({ error: 'Invalid filename' });
            return;
          }
          await mkdir(dirname(finalPath), { recursive: true });
          const targetExisted = await stat(finalPath).then(() => true).catch(() => false);
          await rename(staged.tempPath, finalPath);
          if (!targetExisted) {
            alreadyMoved.push(finalPath);
          }
          uploadedFiles.push(formatDisplayPath(finalPath));
        }
      }

      reply.code(201).send({ success: true, files: uploadedFiles });
    } catch (error) {
      for (const staged of pendingFiles) {
        await rm(staged.tempPath, { force: true }).catch(() => {});
      }
      for (const finalPath of alreadyMoved) {
        await rm(finalPath, { force: true }).catch(() => {});
      }
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

    const safePath = await resolvePathAnywhere(query.data.path);

    try {
      const stats = await stat(safePath);
      if (stats.isDirectory()) {
        const folderName = basename(safePath) || 'download';
        const zipFileName = `${folderName}.zip`.replace(/["\\;\r\n]/g, '_');

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipFileName}"`,
          'Transfer-Encoding': 'chunked'
        });

        const archive = archiver('zip', { zlib: { level: 5 } });
        archive.on('error', (err) => {
          console.error('Archive error:', err);
          reply.raw.destroy(err);
        });

        archive.pipe(reply.raw);
        archive.directory(safePath, folderName);

        try {
          await archive.finalize();
        } catch (error) {
          console.error('Archive finalize error:', error);
          reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }

      const filename = basename(safePath).replace(/["\\;\r\n]/g, '_');
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

    const safePath = await resolvePathAnywhere(body.data.path);

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

    const safeOldPath = await resolvePathAnywhere(body.data.oldPath);
    const safeNewPath = await resolvePathAnywhere(body.data.newPath);

    try {
      await rename(safeOldPath, safeNewPath);
      reply.send({ success: true, path: formatDisplayPath(safeNewPath) });
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

    const safeZipPath = await resolvePathAnywhere(body.data.zipPath);

    // Default extract to same directory as zip file
    const extractTo = body.data.extractTo || dirname(body.data.zipPath);
    const safeExtractPath = await resolvePathAnywhere(extractTo);

    try {
      // Check if file exists and is a zip
      const stats = await stat(safeZipPath);
      if (stats.isDirectory()) {
        reply.code(400).send({ error: 'Path is a directory, not a zip file' });
        return;
      }

      // Validate entries to prevent Zip Slip
      const directory = await Open.file(safeZipPath);
      for (const entry of directory.files) {
        const entryPath = entry.path.replace(/\\/g, '/');
        const resolvedPath = resolve(safeExtractPath, entryPath);
        if (!isWithinBase(safeExtractPath, resolvedPath)) {
          reply.code(400).send({ error: 'Zip contains invalid paths' });
          return;
        }
      }

      // Extract the zip safely
      for (const entry of directory.files) {
        const entryPath = entry.path.replace(/\\/g, '/');
        const resolvedPath = resolve(safeExtractPath, entryPath);

        if (entry.type === 'Directory') {
          await mkdir(resolvedPath, { recursive: true });
          continue;
        }
        if (entry.type !== 'File') {
          continue;
        }

        await mkdir(dirname(resolvedPath), { recursive: true });
        await pipeline(entry.stream(), createWriteStream(resolvedPath));
      }

      reply.send({ success: true, extractedTo: formatDisplayPath(safeExtractPath) });
    } catch (error) {
      reply.code(500).send({ error: 'Failed to extract zip', message: (error as Error).message });
    }
  });

  // Upload screenshot for terminal paste
  const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024; // 10MB
  const ALLOWED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/avif',
    'image/tiff',
    'image/bmp'
  ];
  const IMAGE_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp'
  };
  const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
  const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heif']);
  const AVIF_BRANDS = new Set(['avif', 'avis']);

  const detectImageMime = (buffer: Buffer): string | null => {
    if (buffer.length < 12) return null;
    if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
    const gifHeader = buffer.slice(0, 6).toString('ascii');
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return 'image/gif';
    }
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return 'image/bmp';
    }
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
      return 'image/webp';
    }
    if (
      (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
    ) {
      return 'image/tiff';
    }
    if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
      const brand = buffer.slice(8, 12).toString('ascii');
      if (AVIF_BRANDS.has(brand)) return 'image/avif';
      if (HEIC_BRANDS.has(brand)) return 'image/heic';
      if (HEIF_BRANDS.has(brand)) return 'image/heif';
    }
    return null;
  };

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
          const isKnownImageType = ALLOWED_IMAGE_TYPES.includes(part.mimetype);
          const isSniffableType = !part.mimetype || part.mimetype === 'application/octet-stream';
          if (!isKnownImageType && !isSniffableType) {
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

          let mimetype = part.mimetype;
          const data = Buffer.concat(chunks);
          if (!ALLOWED_IMAGE_TYPES.includes(mimetype)) {
            const detected = detectImageMime(data);
            if (!detected) {
              reply.code(400).send({
                error: 'Invalid file type',
                message: `Allowed types: ${ALLOWED_IMAGE_TYPES.join(', ')}`
              });
              return;
            }
            mimetype = detected;
          }

          imageFile = {
            data,
            mimetype
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
      const ext = IMAGE_EXTENSIONS[imageFile.mimetype] || 'png';
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
