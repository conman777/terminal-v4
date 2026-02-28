import type { FastifyInstance } from 'fastify';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, parse, resolve } from 'node:path';
import archiver from 'archiver';
import { resolvePathAnywhere, PROJECT_ROOT } from '../utils/path-security';

export async function registerFilesystemRoutes(app: FastifyInstance): Promise<void> {
  // Filesystem: List directories
  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (request, reply) => {
    // Resolve to absolute path
    const requestedPath = resolve(request.query.path || PROJECT_ROOT);
    const safePath = await resolvePathAnywhere(requestedPath);

    try {
      const stats = await stat(safePath);
      if (!stats.isDirectory()) {
        reply.code(400).send({ error: 'Path is not a directory' });
        return;
      }

      const entries = await readdir(safePath, { withFileTypes: true });
      const folders = entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Get parent directory (null if at filesystem root)
      const parsed = parse(safePath);
      const parent = parsed.root === safePath ? null : dirname(safePath);

      reply.send({
        path: safePath,
        folders,
        parent
      });
    } catch (error) {
      reply.code(400).send({
        error: 'Cannot access directory',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Filesystem: Download directory as zip
  app.get<{ Querystring: { path?: string } }>('/api/fs/download', async (request, reply) => {
    const requestedPath = resolve(request.query.path || PROJECT_ROOT);
    const safePath = await resolvePathAnywhere(requestedPath);

    let stats;
    try {
      stats = await stat(safePath);
    } catch (error) {
      reply.code(400).send({
        error: 'Cannot download directory',
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (!stats.isDirectory()) {
      reply.code(400).send({ error: 'Path is not a directory' });
      return;
    }

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

    // Add the directory contents to the zip
    archive.directory(safePath, folderName);

    try {
      await archive.finalize();
    } catch (error) {
      console.error('Archive finalize error:', error);
      reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
