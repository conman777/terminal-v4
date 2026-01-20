/**
 * Device Presets for Responsive Design Testing
 *
 * Database of common device configurations including dimensions,
 * pixel ratios, and user agents for testing responsive designs.
 */

export const DEVICE_PRESETS = {
  // Mobile - iPhone
  'iphone-se': {
    name: 'iPhone SE',
    width: 375,
    height: 667,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'mobile',
    touch: true
  },
  'iphone-12': {
    name: 'iPhone 12/13',
    width: 390,
    height: 844,
    pixelRatio: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'mobile',
    touch: true
  },
  'iphone-14-pro': {
    name: 'iPhone 14 Pro',
    width: 393,
    height: 852,
    pixelRatio: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'mobile',
    touch: true
  },
  'iphone-15-pro-max': {
    name: 'iPhone 15 Pro Max',
    width: 430,
    height: 932,
    pixelRatio: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'mobile',
    touch: true
  },

  // Mobile - Android
  'pixel-5': {
    name: 'Pixel 5',
    width: 393,
    height: 851,
    pixelRatio: 2.75,
    userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    type: 'mobile',
    touch: true
  },
  'pixel-7': {
    name: 'Pixel 7',
    width: 412,
    height: 915,
    pixelRatio: 2.625,
    userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    type: 'mobile',
    touch: true
  },
  'galaxy-s21': {
    name: 'Galaxy S21',
    width: 360,
    height: 800,
    pixelRatio: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    type: 'mobile',
    touch: true
  },
  'galaxy-s23-ultra': {
    name: 'Galaxy S23 Ultra',
    width: 412,
    height: 915,
    pixelRatio: 3.5,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    type: 'mobile',
    touch: true
  },

  // Tablet - iPad
  'ipad-mini': {
    name: 'iPad Mini',
    width: 768,
    height: 1024,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'tablet',
    touch: true
  },
  'ipad-air': {
    name: 'iPad Air',
    width: 820,
    height: 1180,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'tablet',
    touch: true
  },
  'ipad-pro-11': {
    name: 'iPad Pro 11"',
    width: 834,
    height: 1194,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'tablet',
    touch: true
  },
  'ipad-pro-13': {
    name: 'iPad Pro 13"',
    width: 1024,
    height: 1366,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    type: 'tablet',
    touch: true
  },

  // Tablet - Android
  'galaxy-tab-s8': {
    name: 'Galaxy Tab S8',
    width: 800,
    height: 1280,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X706B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    type: 'tablet',
    touch: true
  },

  // Desktop
  'desktop-1080p': {
    name: 'Desktop 1080p',
    width: 1920,
    height: 1080,
    pixelRatio: 1,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    type: 'desktop',
    touch: false
  },
  'desktop-1440p': {
    name: 'Desktop 1440p',
    width: 2560,
    height: 1440,
    pixelRatio: 1,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    type: 'desktop',
    touch: false
  },
  'desktop-4k': {
    name: 'Desktop 4K',
    width: 3840,
    height: 2160,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    type: 'desktop',
    touch: false
  },
  'macbook-air': {
    name: 'MacBook Air',
    width: 1440,
    height: 900,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    type: 'desktop',
    touch: false
  },
  'macbook-pro-14': {
    name: 'MacBook Pro 14"',
    width: 1512,
    height: 982,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    type: 'desktop',
    touch: false
  },
  'macbook-pro-16': {
    name: 'MacBook Pro 16"',
    width: 1728,
    height: 1117,
    pixelRatio: 2,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    type: 'desktop',
    touch: false
  }
};

/**
 * Get device preset by ID
 */
export function getDevicePreset(presetId) {
  return DEVICE_PRESETS[presetId] || null;
}

/**
 * Get all device presets grouped by type
 */
export function getDevicePresetsByType() {
  const grouped = {
    mobile: [],
    tablet: [],
    desktop: []
  };

  Object.entries(DEVICE_PRESETS).forEach(([id, preset]) => {
    grouped[preset.type].push({ id, ...preset });
  });

  return grouped;
}

/**
 * Get list of all device preset IDs
 */
export function getDevicePresetIds() {
  return Object.keys(DEVICE_PRESETS);
}

/**
 * Rotate device dimensions (portrait/landscape)
 */
export function rotateDeviceDimensions(preset) {
  return {
    ...preset,
    width: preset.height,
    height: preset.width
  };
}

/**
 * Create custom device preset
 */
export function createCustomDevice(name, width, height, pixelRatio = 1, userAgent = null, type = 'custom', touch = false) {
  return {
    name,
    width,
    height,
    pixelRatio,
    userAgent: userAgent || DEVICE_PRESETS['desktop-1080p'].userAgent,
    type,
    touch
  };
}

/**
 * Validate device dimensions
 */
export function validateDeviceDimensions(width, height) {
  // Type validation
  if (typeof width !== 'number' || typeof height !== 'number') {
    return { valid: false, error: 'Width and height must be numbers' };
  }

  if (isNaN(width) || isNaN(height)) {
    return { valid: false, error: 'Width and height must be valid numbers' };
  }

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { valid: false, error: 'Width and height must be integers' };
  }

  const minDimension = 320;
  const maxDimension = 4096;

  if (width < minDimension || width > maxDimension) {
    return { valid: false, error: `Width must be between ${minDimension} and ${maxDimension}px` };
  }

  if (height < minDimension || height > maxDimension) {
    return { valid: false, error: `Height must be between ${minDimension} and ${maxDimension}px` };
  }

  return { valid: true };
}
