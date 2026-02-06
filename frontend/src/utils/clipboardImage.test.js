import { describe, expect, it } from 'vitest';
import {
  detectImageMimeFromBytes,
  getImageFileFromClipboardItems,
  getImageFileFromDataTransfer,
  hasMeaningfulClipboardText,
  normalizeClipboardImageCandidate,
  shouldPreferImageOverText
} from './clipboardImage';

const PNG_HEADER_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00
]);

describe('clipboardImage', () => {
  it('detects PNG bytes', () => {
    expect(detectImageMimeFromBytes(PNG_HEADER_BYTES)).toBe('image/png');
  });

  it('normalizes unknown MIME clipboard file using content sniffing', async () => {
    const input = new File([PNG_HEADER_BYTES], 'IMG_1234', { type: '' });
    const normalized = await normalizeClipboardImageCandidate(input);
    expect(normalized).toBeInstanceOf(File);
    expect(normalized?.type).toBe('image/png');
    expect(normalized?.name).toBe('IMG_1234.png');
  });

  it('extracts image from data transfer when MIME type is octet-stream', async () => {
    const input = new File([PNG_HEADER_BYTES], 'screenshot', { type: 'application/octet-stream' });
    const dataTransfer = {
      files: [input],
      items: []
    };
    const image = await getImageFileFromDataTransfer(dataTransfer);
    expect(image).toBeInstanceOf(File);
    expect(image?.type).toBe('image/png');
  });

  it('extracts image from async clipboard items with unknown MIME', async () => {
    const clipboardItems = [
      {
        types: ['application/octet-stream'],
        async getType() {
          return new Blob([PNG_HEADER_BYTES], { type: 'application/octet-stream' });
        }
      }
    ];
    const image = await getImageFileFromClipboardItems(clipboardItems);
    expect(image).toBeInstanceOf(File);
    expect(image?.type).toBe('image/png');
  });

  it('classifies image placeholder text for image preference', () => {
    expect(hasMeaningfulClipboardText('\u200B  ')).toBe(false);
    expect(shouldPreferImageOverText('IMG_1234.PNG')).toBe(true);
    expect(shouldPreferImageOverText('ls -la')).toBe(false);
  });
});
