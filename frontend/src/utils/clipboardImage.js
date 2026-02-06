const IMAGE_MIME_TO_EXTENSION = {
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

const IMAGE_EXTENSIONS = new Set(Object.values(IMAGE_MIME_TO_EXTENSION));
const SNIFFABLE_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const IMAGE_TEXT_PLACEHOLDERS = [
  /^image$/i,
  /^photo$/i,
  /^screenshot$/i,
  /^screenshot[-_ ]?\d+$/i,
  /^img[-_ ]?\d+(\.[a-z0-9]+)?$/i,
  /^image[-_ ]?\d+(\.[a-z0-9]+)?$/i,
  /^[^\s]+\.(png|jpe?g|gif|webp|heic|heif|avif|tiff?|bmp)$/i
];
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heif']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function normalizeMimeType(value) {
  return (value || '').toLowerCase().split(';')[0].trim();
}

function getFileExtension(name) {
  if (!name || typeof name !== 'string') return '';
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

function isImageMimeType(value) {
  return normalizeMimeType(value).startsWith('image/');
}

function isSniffableMimeType(value) {
  return SNIFFABLE_MIME_TYPES.has(normalizeMimeType(value));
}

function getExtensionForMimeType(value) {
  const mime = normalizeMimeType(value);
  if (IMAGE_MIME_TO_EXTENSION[mime]) return IMAGE_MIME_TO_EXTENSION[mime];
  if (mime.startsWith('image/')) return mime.slice('image/'.length);
  return '';
}

function mimeTypeFromExtension(ext) {
  if (!ext) return '';
  const normalized = ext.toLowerCase();
  const entry = Object.entries(IMAGE_MIME_TO_EXTENSION).find(([, imageExt]) => imageExt === normalized);
  return entry ? entry[0] : '';
}

function readAscii(bytes, start, end) {
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

export function detectImageMimeFromBytes(bytes) {
  if (!bytes || bytes.length < 12) return '';

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  const gifHeader = readAscii(bytes, 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return 'image/gif';
  }

  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }

  if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return 'image/tiff';
  }

  if (readAscii(bytes, 4, 8) === 'ftyp') {
    const brand = readAscii(bytes, 8, 12);
    if (AVIF_BRANDS.has(brand)) return 'image/avif';
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }

  return '';
}

async function detectImageMimeFromBlob(blob) {
  if (!blob) return '';
  const headerSize = Math.min(64, blob.size || 64);
  const head = blob.slice(0, headerSize);

  try {
    if (typeof head.arrayBuffer === 'function') {
      const buffer = await head.arrayBuffer();
      const detected = detectImageMimeFromBytes(new Uint8Array(buffer));
      if (detected) return detected;
    }
  } catch {
    // Fall back to alternate readers.
  }

  try {
    if (typeof Response !== 'undefined') {
      const buffer = await new Response(head).arrayBuffer();
      const detected = detectImageMimeFromBytes(new Uint8Array(buffer));
      if (detected) return detected;
    }
  } catch {
    // Fall back to FileReader if available.
  }

  if (typeof FileReader === 'undefined') {
    return '';
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve('');
    reader.onload = () => {
      const result = reader.result;
      if (!(result instanceof ArrayBuffer)) {
        resolve('');
        return;
      }
      resolve(detectImageMimeFromBytes(new Uint8Array(result)));
    };
    reader.readAsArrayBuffer(head);
  });
}

function buildImageFilename(name, mimeType) {
  const extension = getExtensionForMimeType(mimeType) || 'png';
  if (!name || !name.trim()) {
    return `pasted-image.${extension}`;
  }
  if (getFileExtension(name)) return name;
  return `${name}.${extension}`;
}

export function normalizeClipboardText(text) {
  return (text || '').replace(/\u200B/g, '').trim();
}

export function hasMeaningfulClipboardText(text) {
  return normalizeClipboardText(text).length > 0;
}

export function shouldPreferImageOverText(text) {
  const normalized = normalizeClipboardText(text);
  if (!normalized) return true;
  if (normalized.toLowerCase().startsWith('data:image/')) return true;
  return IMAGE_TEXT_PLACEHOLDERS.some((pattern) => pattern.test(normalized));
}

export async function normalizeClipboardImageCandidate(candidate) {
  if (!candidate) return null;

  const candidateName = typeof candidate.name === 'string' ? candidate.name : '';
  const ext = getFileExtension(candidateName);
  const type = normalizeMimeType(candidate.type);

  let mimeType = '';
  if (isImageMimeType(type)) {
    mimeType = type;
  } else if (isSniffableMimeType(type) || IMAGE_EXTENSIONS.has(ext)) {
    mimeType = await detectImageMimeFromBlob(candidate);
    if (!mimeType && IMAGE_EXTENSIONS.has(ext)) {
      mimeType = mimeTypeFromExtension(ext);
    }
  }

  if (!mimeType) {
    return null;
  }

  const fileName = buildImageFilename(candidateName, mimeType);
  if (candidate instanceof File && normalizeMimeType(candidate.type) === mimeType && candidate.name === fileName) {
    return candidate;
  }

  return new File([candidate], fileName, { type: mimeType });
}

export async function getImageFileFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return null;

  const seen = new Set();
  const candidates = [];
  const files = Array.from(dataTransfer.files || []);
  for (const file of files) {
    if (file && !seen.has(file)) {
      seen.add(file);
      candidates.push(file);
    }
  }

  const items = Array.from(dataTransfer.items || []);
  for (const item of items) {
    if (!item || item.kind !== 'file' || typeof item.getAsFile !== 'function') continue;
    const file = item.getAsFile();
    if (file && !seen.has(file)) {
      seen.add(file);
      candidates.push(file);
    }
  }

  for (const candidate of candidates) {
    const image = await normalizeClipboardImageCandidate(candidate);
    if (image) return image;
  }

  return null;
}

function imageFromDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const [, mimeTypeRaw, base64Data] = match;
  const mimeType = normalizeMimeType(mimeTypeRaw);
  if (!isImageMimeType(mimeType)) return null;
  const binary = atob(base64Data.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const extension = getExtensionForMimeType(mimeType) || 'png';
  return new File([bytes], `pasted-image.${extension}`, { type: mimeType });
}

async function extractImageFromHtmlClipboardItem(item) {
  const itemTypes = Array.from(item?.types || []);
  if (!itemTypes.includes('text/html') || typeof item.getType !== 'function') return null;
  try {
    const htmlBlob = await item.getType('text/html');
    const html = await htmlBlob.text();
    const dataUrlMatch = html.match(/src=["'](data:image\/[a-z0-9.+-]+;base64,[^"']+)["']/i);
    if (!dataUrlMatch) return null;
    return imageFromDataUrl(dataUrlMatch[1]);
  } catch {
    return null;
  }
}

export async function getImageFileFromClipboardItems(clipboardItems) {
  if (!Array.isArray(clipboardItems)) return null;

  for (const item of clipboardItems) {
    if (!item || typeof item.getType !== 'function') continue;

    const itemTypes = Array.from(item.types || []);
    const imageTypes = itemTypes.filter((type) => isImageMimeType(type));
    const maybeImageTypes = itemTypes.filter((type) => isSniffableMimeType(type));
    const candidateTypes = [...imageTypes, ...maybeImageTypes];

    for (const type of candidateTypes) {
      try {
        const blob = await item.getType(type);
        const image = await normalizeClipboardImageCandidate(blob);
        if (image) return image;
      } catch {
        // Ignore item/type failures and continue checking other clipboard entries.
      }
    }

    const imageFromHtml = await extractImageFromHtmlClipboardItem(item);
    if (imageFromHtml) {
      return imageFromHtml;
    }
  }

  return null;
}
