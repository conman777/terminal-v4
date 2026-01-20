/**
 * Visual Regression Service
 *
 * Provides visual regression testing capabilities using pixelmatch for image comparison.
 * Supports configurable thresholds, ignore regions, and baseline management.
 */

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { Readable } from 'stream';

export interface DiffOptions {
  threshold?: number; // Matching threshold (0-1), smaller = more sensitive
  includeAA?: boolean; // Include anti-aliasing in comparison
  alpha?: number; // Opacity of diff output
  diffColor?: [number, number, number]; // RGB color for differences
  aaColor?: [number, number, number]; // RGB color for anti-aliasing
  ignoreRegions?: Array<{ x: number; y: number; width: number; height: number }>;
}

export interface DiffResult {
  matches: boolean;
  pixelsDifferent: number;
  totalPixels: number;
  percentDifferent: number;
  diffImage: Buffer;
  width: number;
  height: number;
}

/**
 * Compare two images and generate diff
 */
export async function compareImages(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  options: DiffOptions = {}
): Promise<DiffResult> {
  // Validate buffers
  if (!baselineBuffer || baselineBuffer.length < 24) {
    throw new Error('Invalid baseline image buffer');
  }
  if (!currentBuffer || currentBuffer.length < 24) {
    throw new Error('Invalid current image buffer');
  }

  // Parse images with timeout protection
  const parseTimeout = 10000; // 10 seconds
  const baseline = await Promise.race([
    parseImage(baselineBuffer),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Baseline image parsing timeout')), parseTimeout)
    )
  ]);
  const current = await Promise.race([
    parseImage(currentBuffer),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Current image parsing timeout')), parseTimeout)
    )
  ]);

  // Validate dimensions match
  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw new Error(
      `Image dimensions don't match: baseline(${baseline.width}x${baseline.height}) vs current(${current.width}x${current.height})`
    );
  }

  const { width, height } = baseline;
  const totalPixels = width * height;

  // Apply ignore regions if specified
  const baselineData = baseline.data;
  const currentData = current.data;
  if (options.ignoreRegions && options.ignoreRegions.length > 0) {
    applyIgnoreRegions(baselineData, currentData, width, height, options.ignoreRegions);
  }

  // Create diff image
  const diff = new PNG({ width, height });

  // Compare images
  const pixelsDifferent = pixelmatch(
    baselineData,
    currentData,
    diff.data,
    width,
    height,
    {
      threshold: options.threshold !== undefined ? options.threshold : 0.1,
      includeAA: options.includeAA !== undefined ? options.includeAA : false,
      alpha: options.alpha,
      diffColor: options.diffColor,
      aaColor: options.aaColor
    }
  );

  const percentDifferent = (pixelsDifferent / totalPixels) * 100;
  const matches = pixelsDifferent === 0;

  // Encode diff image
  const diffImage = await encodeImage(diff);

  return {
    matches,
    pixelsDifferent,
    totalPixels,
    percentDifferent,
    diffImage,
    width,
    height
  };
}

/**
 * Apply ignore regions by copying baseline pixels to current image
 * This ensures ignored regions don't contribute to the diff
 */
function applyIgnoreRegions(
  baselineData: Uint8Array | Buffer,
  currentData: Uint8Array | Buffer,
  width: number,
  height: number,
  ignoreRegions: Array<{ x: number; y: number; width: number; height: number }>
): void {
  for (const region of ignoreRegions) {
    const { x, y, width: regionWidth, height: regionHeight } = region;

    // Validate region bounds
    if (x < 0 || y < 0 || x + regionWidth > width || y + regionHeight > height) {
      console.warn(`Ignore region out of bounds: ${JSON.stringify(region)}`);
      continue;
    }

    // Copy baseline pixels to current for this region
    for (let row = y; row < y + regionHeight; row++) {
      for (let col = x; col < x + regionWidth; col++) {
        const idx = (row * width + col) * 4;
        currentData[idx] = baselineData[idx]; // R
        currentData[idx + 1] = baselineData[idx + 1]; // G
        currentData[idx + 2] = baselineData[idx + 2]; // B
        currentData[idx + 3] = baselineData[idx + 3]; // A
      }
    }
  }
}

/**
 * Parse PNG image buffer
 */
function parseImage(buffer: Buffer): Promise<PNG> {
  return new Promise((resolve, reject) => {
    const png = new PNG();

    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    stream
      .pipe(png)
      .on('parsed', function() {
        resolve(this as PNG);
      })
      .on('error', reject);
  });
}

/**
 * Encode PNG image to buffer
 */
function encodeImage(png: PNG): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    png
      .pack()
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

/**
 * Calculate automatic threshold based on image complexity
 * More complex images may need higher threshold
 */
export function calculateAutoThreshold(imageBuffer: Buffer): Promise<number> {
  // Simple heuristic: base threshold on image variance
  // Higher variance = more complex = higher threshold
  return parseImage(imageBuffer).then(png => {
    const { data, width, height } = png;
    const totalPixels = width * height;

    // Calculate variance of luminance
    let sum = 0;
    let sumSquares = 0;

    for (let i = 0; i < data.length; i += 4) {
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += luminance;
      sumSquares += luminance * luminance;
    }

    const mean = sum / totalPixels;
    const variance = sumSquares / totalPixels - mean * mean;

    // Map variance (0-10000) to threshold (0.05-0.2)
    const normalizedVariance = Math.min(variance / 10000, 1);
    const threshold = 0.05 + normalizedVariance * 0.15;

    return Math.round(threshold * 1000) / 1000; // Round to 3 decimals
  });
}

/**
 * Validate diff options
 */
export function validateDiffOptions(options: DiffOptions): { valid: boolean; error?: string } {
  if (options.threshold !== undefined) {
    if (options.threshold < 0 || options.threshold > 1) {
      return { valid: false, error: 'threshold must be between 0 and 1' };
    }
  }

  if (options.alpha !== undefined) {
    if (options.alpha < 0 || options.alpha > 1) {
      return { valid: false, error: 'alpha must be between 0 and 1' };
    }
  }

  if (options.diffColor) {
    if (!Array.isArray(options.diffColor) || options.diffColor.length !== 3) {
      return { valid: false, error: 'diffColor must be [r, g, b] array' };
    }
    if (options.diffColor.some(c => c < 0 || c > 255)) {
      return { valid: false, error: 'diffColor values must be between 0 and 255' };
    }
  }

  if (options.aaColor) {
    if (!Array.isArray(options.aaColor) || options.aaColor.length !== 3) {
      return { valid: false, error: 'aaColor must be [r, g, b] array' };
    }
    if (options.aaColor.some(c => c < 0 || c > 255)) {
      return { valid: false, error: 'aaColor values must be between 0 and 255' };
    }
  }

  if (options.ignoreRegions) {
    if (!Array.isArray(options.ignoreRegions)) {
      return { valid: false, error: 'ignoreRegions must be an array' };
    }
    for (const region of options.ignoreRegions) {
      if (!region || typeof region !== 'object') {
        return { valid: false, error: 'ignoreRegion must be an object' };
      }
      if (
        typeof region.x !== 'number' ||
        typeof region.y !== 'number' ||
        typeof region.width !== 'number' ||
        typeof region.height !== 'number'
      ) {
        return { valid: false, error: 'ignoreRegion must have x, y, width, height numbers' };
      }
      if (region.width <= 0 || region.height <= 0) {
        return { valid: false, error: 'ignoreRegion width and height must be positive' };
      }
    }
  }

  return { valid: true };
}
