import { describe, it, expect, beforeAll } from 'vitest';
import { PNG } from 'pngjs';
import {
  compareImages,
  calculateAutoThreshold,
  validateDiffOptions,
  type DiffOptions
} from '../src/browser/visual-regression-service';

/**
 * Create a simple test PNG image
 */
function createTestImage(width: number, height: number, color: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  const [r, g, b] = color;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255; // Alpha
    }
  }

  return PNG.sync.write(png);
}

/**
 * Create a test image with a specific pattern
 */
function createPatternImage(width: number, height: number): Buffer {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Checkerboard pattern
      const isEven = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0;
      const color = isEven ? 255 : 0;
      png.data[idx] = color;
      png.data[idx + 1] = color;
      png.data[idx + 2] = color;
      png.data[idx + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

/**
 * Create a test image with a rectangle drawn on it
 */
function createImageWithRect(
  width: number,
  height: number,
  bgColor: [number, number, number],
  rectX: number,
  rectY: number,
  rectWidth: number,
  rectHeight: number,
  rectColor: [number, number, number]
): Buffer {
  const png = new PNG({ width, height });
  const [bgR, bgG, bgB] = bgColor;
  const [rectR, rectG, rectB] = rectColor;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inRect = x >= rectX && x < rectX + rectWidth && y >= rectY && y < rectY + rectHeight;

      if (inRect) {
        png.data[idx] = rectR;
        png.data[idx + 1] = rectG;
        png.data[idx + 2] = rectB;
      } else {
        png.data[idx] = bgR;
        png.data[idx + 1] = bgG;
        png.data[idx + 2] = bgB;
      }
      png.data[idx + 3] = 255;
    }
  }

  return PNG.sync.write(png);
}

describe('visual-regression-service', () => {
  describe('compareImages', () => {
    it('should detect identical images', async () => {
      const imageWidth = 100;
      const imageHeight = 100;
      const testColor: [number, number, number] = [255, 0, 0];
      const image1 = createTestImage(imageWidth, imageHeight, testColor);
      const image2 = createTestImage(imageWidth, imageHeight, testColor);

      const result = await compareImages(image1, image2);

      expect(result).toEqual({
        matches: true,
        pixelsDifferent: 0,
        totalPixels: imageWidth * imageHeight,
        percentDifferent: 0,
        diffImage: expect.any(Buffer),
        width: imageWidth,
        height: imageHeight
      });
    });

    it('should detect different images', async () => {
      const imageWidth = 100;
      const imageHeight = 100;
      const image1 = createTestImage(imageWidth, imageHeight, [255, 0, 0]);
      const image2 = createTestImage(imageWidth, imageHeight, [0, 0, 255]);

      const result = await compareImages(image1, image2);

      expect(result.matches).toBe(false);
      expect(result.pixelsDifferent).toBeGreaterThan(0);
      expect(result.totalPixels).toBe(imageWidth * imageHeight);
      expect(result.percentDifferent).toBeGreaterThan(0);
      expect(result.diffImage).toBeInstanceOf(Buffer);
    });

    it('should detect partial differences', async () => {
      const imageWidth = 100;
      const imageHeight = 100;
      const bgColor: [number, number, number] = [255, 255, 255];
      const rectColor1: [number, number, number] = [255, 0, 0];
      const rectColor2: [number, number, number] = [0, 0, 255];

      const image1 = createImageWithRect(imageWidth, imageHeight, bgColor, 25, 25, 50, 50, rectColor1);
      const image2 = createImageWithRect(imageWidth, imageHeight, bgColor, 25, 25, 50, 50, rectColor2);

      const result = await compareImages(image1, image2);

      expect(result.matches).toBe(false);
      // Only the rectangle pixels should be different (50x50 = 2500 pixels)
      expect(result.pixelsDifferent).toBe(2500);
      expect(result.percentDifferent).toBe(25); // 2500 / 10000 = 25%
    });

    it('should throw error for mismatched dimensions', async () => {
      const image1 = createTestImage(100, 100, [255, 0, 0]);
      const image2 = createTestImage(200, 100, [255, 0, 0]);

      await expect(compareImages(image1, image2)).rejects.toThrow(/dimensions don't match/i);
    });

    it('should respect threshold option', async () => {
      const imageWidth = 100;
      const imageHeight = 100;
      const image1 = createTestImage(imageWidth, imageHeight, [100, 100, 100]);
      const image2 = createTestImage(imageWidth, imageHeight, [105, 105, 105]);

      // With low threshold (sensitive), small difference should be detected
      const sensitiveResult = await compareImages(image1, image2, { threshold: 0.01 });
      expect(sensitiveResult.matches).toBe(false);

      // With high threshold (tolerant), small difference should be ignored
      const tolerantResult = await compareImages(image1, image2, { threshold: 0.5 });
      expect(tolerantResult.pixelsDifferent).toBeLessThan(sensitiveResult.pixelsDifferent);
    });

    it('should apply ignore regions', async () => {
      const imageWidth = 100;
      const imageHeight = 100;
      const bgColor: [number, number, number] = [255, 255, 255];
      const rectColor1: [number, number, number] = [255, 0, 0];
      const rectColor2: [number, number, number] = [0, 0, 255];

      const image1 = createImageWithRect(imageWidth, imageHeight, bgColor, 25, 25, 50, 50, rectColor1);
      const image2 = createImageWithRect(imageWidth, imageHeight, bgColor, 25, 25, 50, 50, rectColor2);

      // Compare without ignore region
      const resultWithoutIgnore = await compareImages(image1, image2);
      expect(resultWithoutIgnore.matches).toBe(false);
      expect(resultWithoutIgnore.pixelsDifferent).toBe(2500);

      // Compare with ignore region covering the rectangle
      const resultWithIgnore = await compareImages(image1, image2, {
        ignoreRegions: [{ x: 25, y: 25, width: 50, height: 50 }]
      });
      expect(resultWithIgnore.matches).toBe(true);
      expect(resultWithIgnore.pixelsDifferent).toBe(0);
    });
  });

  describe('calculateAutoThreshold', () => {
    it('should calculate threshold for solid color image', async () => {
      const solidImage = createTestImage(100, 100, [128, 128, 128]);
      const threshold = await calculateAutoThreshold(solidImage);

      expect(threshold).toBeGreaterThanOrEqual(0.05);
      expect(threshold).toBeLessThanOrEqual(0.2);
      expect(typeof threshold).toBe('number');
    });

    it('should calculate higher threshold for complex pattern', async () => {
      const patternImage = createPatternImage(100, 100);
      const threshold = await calculateAutoThreshold(patternImage);

      expect(threshold).toBeGreaterThanOrEqual(0.05);
      expect(threshold).toBeLessThanOrEqual(0.2);
    });

    it('should calculate different thresholds for different complexity', async () => {
      const solidImage = createTestImage(100, 100, [128, 128, 128]);
      const patternImage = createPatternImage(100, 100);

      const solidThreshold = await calculateAutoThreshold(solidImage);
      const patternThreshold = await calculateAutoThreshold(patternImage);

      // Pattern should have higher threshold due to higher variance
      expect(patternThreshold).toBeGreaterThan(solidThreshold);
    });
  });

  describe('validateDiffOptions', () => {
    it('should validate empty options', () => {
      const result = validateDiffOptions({});
      expect(result).toEqual({ valid: true });
    });

    it('should validate valid threshold', () => {
      const result = validateDiffOptions({ threshold: 0.5 });
      expect(result).toEqual({ valid: true });
    });

    it('should reject threshold below 0', () => {
      const result = validateDiffOptions({ threshold: -0.1 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('threshold');
    });

    it('should reject threshold above 1', () => {
      const result = validateDiffOptions({ threshold: 1.5 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('threshold');
    });

    it('should validate valid alpha', () => {
      const result = validateDiffOptions({ alpha: 0.8 });
      expect(result).toEqual({ valid: true });
    });

    it('should reject invalid alpha', () => {
      const result = validateDiffOptions({ alpha: 2 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('alpha');
    });

    it('should validate valid diffColor', () => {
      const result = validateDiffOptions({ diffColor: [255, 0, 0] });
      expect(result).toEqual({ valid: true });
    });

    it('should reject invalid diffColor format', () => {
      const result = validateDiffOptions({ diffColor: [255, 0] as any });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('diffColor');
    });

    it('should reject diffColor with out-of-range values', () => {
      const result = validateDiffOptions({ diffColor: [300, 0, 0] });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('diffColor');
    });

    it('should validate valid ignoreRegions', () => {
      const result = validateDiffOptions({
        ignoreRegions: [
          { x: 10, y: 10, width: 50, height: 50 },
          { x: 100, y: 100, width: 20, height: 20 }
        ]
      });
      expect(result).toEqual({ valid: true });
    });

    it('should reject ignoreRegions with invalid structure', () => {
      const result = validateDiffOptions({
        ignoreRegions: [{ x: 10, y: 10, width: 50 } as any]
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('ignoreRegion');
    });

    it('should reject ignoreRegions with non-positive dimensions', () => {
      const result = validateDiffOptions({
        ignoreRegions: [{ x: 10, y: 10, width: -50, height: 50 }]
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('ignoreRegion');
    });
  });
});
