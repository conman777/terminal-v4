/**
 * Baseline Storage Service
 *
 * Manages storage and retrieval of baseline images for visual regression testing.
 * Stores images in /var/lib/terminal-v4/baselines/ directory.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';

const BASELINE_DIR = '/var/lib/terminal-v4/baselines';

export interface BaselineMetadata {
  name: string;
  width: number;
  height: number;
  createdAt: number;
  updatedAt: number;
  url?: string;
  devicePreset?: string;
}

export interface BaselineInfo extends BaselineMetadata {
  path: string;
  size: number;
}

/**
 * Initialize baseline storage directory
 */
export async function initBaselineStorage(): Promise<void> {
  try {
    await fs.mkdir(BASELINE_DIR, { recursive: true, mode: 0o755 });
  } catch (err: any) {
    if (err.code !== 'EEXIST') {
      throw new Error(`Failed to create baseline directory: ${err.message}`);
    }
  }
}

/**
 * Save baseline image
 */
export async function saveBaseline(
  name: string,
  imageBuffer: Buffer,
  metadata: Partial<BaselineMetadata>
): Promise<BaselineInfo> {
  await initBaselineStorage();

  // Validate file size FIRST (max 10MB)
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
  if (imageBuffer.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB (max 10MB)`);
  }

  // Validate PNG signature before anything else
  const dimensions = getImageDimensions(imageBuffer);

  // Sanitize name for filesystem (includes path traversal checks)
  const sanitizedName = sanitizeBaselineName(name);
  const imagePath = join(BASELINE_DIR, `${sanitizedName}.png`);
  const metadataPath = join(BASELINE_DIR, `${sanitizedName}.json`);

  // Create metadata
  const now = Date.now();
  const baselineMetadata: BaselineMetadata = {
    name,
    width: metadata.width || dimensions.width,
    height: metadata.height || dimensions.height,
    createdAt: metadata.createdAt || now,
    updatedAt: now,
    url: metadata.url,
    devicePreset: metadata.devicePreset
  };

  // Write files
  await fs.writeFile(imagePath, imageBuffer);
  await fs.writeFile(metadataPath, JSON.stringify(baselineMetadata, null, 2));

  // Get file size
  const stats = await fs.stat(imagePath);

  return {
    ...baselineMetadata,
    path: imagePath,
    size: stats.size
  };
}

/**
 * Get baseline image
 */
export async function getBaseline(name: string): Promise<{ image: Buffer; metadata: BaselineMetadata } | null> {
  const sanitizedName = sanitizeBaselineName(name);
  const imagePath = join(BASELINE_DIR, `${sanitizedName}.png`);
  const metadataPath = join(BASELINE_DIR, `${sanitizedName}.json`);

  try {
    const [image, metadataJson] = await Promise.all([
      fs.readFile(imagePath),
      fs.readFile(metadataPath, 'utf-8')
    ]);

    const metadata = JSON.parse(metadataJson) as BaselineMetadata;

    return { image, metadata };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * List all baselines
 */
export async function listBaselines(): Promise<BaselineInfo[]> {
  await initBaselineStorage();

  try {
    const files = await fs.readdir(BASELINE_DIR);
    const pngFiles = files.filter(f => f.endsWith('.png'));

    const baselines = await Promise.all(
      pngFiles.map(async (file) => {
        const baseName = file.replace('.png', '');
        const imagePath = join(BASELINE_DIR, file);
        const metadataPath = join(BASELINE_DIR, `${baseName}.json`);

        try {
          const [stats, metadataJson] = await Promise.all([
            fs.stat(imagePath),
            fs.readFile(metadataPath, 'utf-8')
          ]);

          const metadata = JSON.parse(metadataJson) as BaselineMetadata;

          return {
            ...metadata,
            path: imagePath,
            size: stats.size
          };
        } catch {
          // Skip files with missing or invalid metadata
          return null;
        }
      })
    );

    return baselines.filter((b): b is BaselineInfo => b !== null);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Delete baseline
 */
export async function deleteBaseline(name: string): Promise<boolean> {
  const sanitizedName = sanitizeBaselineName(name);
  const imagePath = join(BASELINE_DIR, `${sanitizedName}.png`);
  const metadataPath = join(BASELINE_DIR, `${sanitizedName}.json`);

  try {
    await Promise.all([
      fs.unlink(imagePath),
      fs.unlink(metadataPath)
    ]);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Check if baseline exists
 */
export async function baselineExists(name: string): Promise<boolean> {
  const sanitizedName = sanitizeBaselineName(name);
  const imagePath = join(BASELINE_DIR, `${sanitizedName}.png`);

  try {
    await fs.access(imagePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize baseline name for filesystem
 */
function sanitizeBaselineName(name: string): string {
  // Validate BEFORE sanitizing to catch path traversal attempts
  if (!name || name.length === 0) {
    throw new Error('Baseline name cannot be empty');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid characters in baseline name: path traversal attempt');
  }
  if (name.length > 255) {
    throw new Error('Baseline name too long (max 255 chars)');
  }

  // Now sanitize
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

/**
 * Extract image dimensions from PNG buffer
 * Simple PNG header parsing (IHDR chunk)
 */
function getImageDimensions(buffer: Buffer): { width: number; height: number } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length < 24) {
    throw new Error('Invalid PNG: buffer too small');
  }

  // Check PNG signature
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
    throw new Error('Invalid PNG: missing PNG signature');
  }

  // IHDR chunk starts at byte 8
  // Width is at bytes 16-19, height at bytes 20-23 (big-endian)
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return { width, height };
}
