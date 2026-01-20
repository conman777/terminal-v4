/**
 * Browser Settings Service
 *
 * Manages configurable browser session settings like timeouts, limits, and quality.
 */

export interface BrowserSettings {
  // Session timeouts
  idleTimeoutMs: number; // Time before idle session is closed (1 min - 1 hour)
  maxLifetimeMs: number; // Maximum session lifetime (10 min - 4 hours)

  // Session limits
  maxSessions: number; // Maximum concurrent sessions (1-20)

  // Cleanup
  cleanupIntervalMs: number; // How often to check for expired sessions (30s - 10 min)
  logRetentionMs: number; // How long to keep logs (10 min - 24 hours)

  // Screenshot settings
  screenshotFormat: 'png' | 'jpeg';
  screenshotQuality: number; // 1-100 (for JPEG)
}

// Default settings
const DEFAULT_SETTINGS: BrowserSettings = {
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  maxLifetimeMs: 30 * 60 * 1000, // 30 minutes
  maxSessions: 5,
  cleanupIntervalMs: 60 * 1000, // 1 minute
  logRetentionMs: 60 * 60 * 1000, // 1 hour
  screenshotFormat: 'png',
  screenshotQuality: 90
};

// Current settings (in-memory, could be persisted to database)
let currentSettings: BrowserSettings = { ...DEFAULT_SETTINGS };

/**
 * Get current browser settings
 */
export function getBrowserSettings(): BrowserSettings {
  return { ...currentSettings };
}

/**
 * Validate a setting value
 */
function validateSettings(updates: Partial<BrowserSettings>): void {
  // Idle timeout validation
  if (updates.idleTimeoutMs !== undefined) {
    if (!Number.isInteger(updates.idleTimeoutMs)) {
      throw new Error('Idle timeout must be an integer');
    }
    const min = 1 * 60 * 1000; // 1 minute
    const max = 60 * 60 * 1000; // 1 hour
    if (updates.idleTimeoutMs < min) {
      throw new Error('Idle timeout must be at least 1 minute');
    }
    if (updates.idleTimeoutMs > max) {
      throw new Error('Idle timeout must be at most 1 hour');
    }
  }

  // Max lifetime validation
  if (updates.maxLifetimeMs !== undefined) {
    if (!Number.isInteger(updates.maxLifetimeMs)) {
      throw new Error('Max lifetime must be an integer');
    }
    const min = 10 * 60 * 1000; // 10 minutes
    const max = 4 * 60 * 60 * 1000; // 4 hours
    if (updates.maxLifetimeMs < min) {
      throw new Error('Max lifetime must be at least 10 minutes');
    }
    if (updates.maxLifetimeMs > max) {
      throw new Error('Max lifetime must be at most 4 hours');
    }
  }

  // Max sessions validation
  if (updates.maxSessions !== undefined) {
    if (!Number.isInteger(updates.maxSessions)) {
      throw new Error('Max sessions must be an integer');
    }
    if (updates.maxSessions < 1 || updates.maxSessions > 20) {
      throw new Error('Max sessions must be between 1 and 20');
    }
  }

  // Cleanup interval validation
  if (updates.cleanupIntervalMs !== undefined) {
    if (!Number.isInteger(updates.cleanupIntervalMs)) {
      throw new Error('Cleanup interval must be an integer');
    }
    const min = 30 * 1000; // 30 seconds
    const max = 10 * 60 * 1000; // 10 minutes
    if (updates.cleanupIntervalMs < min) {
      throw new Error('Cleanup interval must be at least 30 seconds');
    }
    if (updates.cleanupIntervalMs > max) {
      throw new Error('Cleanup interval must be at most 10 minutes');
    }
  }

  // Log retention validation
  if (updates.logRetentionMs !== undefined) {
    if (!Number.isInteger(updates.logRetentionMs)) {
      throw new Error('Log retention must be an integer');
    }
    const min = 10 * 60 * 1000; // 10 minutes
    const max = 24 * 60 * 60 * 1000; // 24 hours
    if (updates.logRetentionMs < min) {
      throw new Error('Log retention must be at least 10 minutes');
    }
    if (updates.logRetentionMs > max) {
      throw new Error('Log retention must be at most 24 hours');
    }
  }

  // Screenshot format validation
  if (updates.screenshotFormat !== undefined) {
    if (updates.screenshotFormat !== 'png' && updates.screenshotFormat !== 'jpeg') {
      throw new Error('Screenshot format must be png or jpeg');
    }
  }

  // Screenshot quality validation
  if (updates.screenshotQuality !== undefined) {
    if (!Number.isInteger(updates.screenshotQuality)) {
      throw new Error('Screenshot quality must be an integer');
    }
    if (updates.screenshotQuality < 1 || updates.screenshotQuality > 100) {
      throw new Error('Screenshot quality must be between 1 and 100');
    }
  }
}

/**
 * Update browser settings
 * Only updates provided fields, others remain unchanged
 */
export function updateBrowserSettings(updates: Partial<BrowserSettings>): BrowserSettings {
  validateSettings(updates);

  currentSettings = {
    ...currentSettings,
    ...updates
  };

  return getBrowserSettings();
}

/**
 * Reset all settings to defaults
 */
export function resetBrowserSettings(): BrowserSettings {
  currentSettings = { ...DEFAULT_SETTINGS };
  return getBrowserSettings();
}

/**
 * Get default settings (useful for UI to show defaults)
 */
export function getDefaultBrowserSettings(): BrowserSettings {
  return { ...DEFAULT_SETTINGS };
}
