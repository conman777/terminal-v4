import { describe, it, expect, beforeEach } from 'vitest';
import {
  getBrowserSettings,
  updateBrowserSettings,
  resetBrowserSettings,
  type BrowserSettings
} from './browser-settings-service';

describe('browser-settings-service', () => {
  beforeEach(() => {
    // Reset to defaults before each test
    resetBrowserSettings();
  });

  describe('Default Settings', () => {
    it('returns default settings on first access', () => {
      const settings = getBrowserSettings();

      expect(settings.idleTimeoutMs).toBe(5 * 60 * 1000); // 5 minutes
      expect(settings.maxLifetimeMs).toBe(30 * 60 * 1000); // 30 minutes
      expect(settings.maxSessions).toBe(5);
      expect(settings.cleanupIntervalMs).toBe(60 * 1000); // 1 minute
      expect(settings.logRetentionMs).toBe(60 * 60 * 1000); // 1 hour
      expect(settings.screenshotFormat).toBe('png');
      expect(settings.screenshotQuality).toBe(90);
    });
  });

  describe('Update Settings', () => {
    it('updates idle timeout', () => {
      updateBrowserSettings({ idleTimeoutMs: 10 * 60 * 1000 });
      const settings = getBrowserSettings();
      expect(settings.idleTimeoutMs).toBe(10 * 60 * 1000);
    });

    it('updates max lifetime', () => {
      updateBrowserSettings({ maxLifetimeMs: 60 * 60 * 1000 });
      const settings = getBrowserSettings();
      expect(settings.maxLifetimeMs).toBe(60 * 60 * 1000);
    });

    it('updates max sessions', () => {
      updateBrowserSettings({ maxSessions: 10 });
      const settings = getBrowserSettings();
      expect(settings.maxSessions).toBe(10);
    });

    it('updates cleanup interval', () => {
      updateBrowserSettings({ cleanupIntervalMs: 30 * 1000 });
      const settings = getBrowserSettings();
      expect(settings.cleanupIntervalMs).toBe(30 * 1000);
    });

    it('updates log retention', () => {
      updateBrowserSettings({ logRetentionMs: 2 * 60 * 60 * 1000 });
      const settings = getBrowserSettings();
      expect(settings.logRetentionMs).toBe(2 * 60 * 60 * 1000);
    });

    it('updates screenshot format', () => {
      updateBrowserSettings({ screenshotFormat: 'jpeg' });
      const settings = getBrowserSettings();
      expect(settings.screenshotFormat).toBe('jpeg');
    });

    it('updates screenshot quality', () => {
      updateBrowserSettings({ screenshotQuality: 80 });
      const settings = getBrowserSettings();
      expect(settings.screenshotQuality).toBe(80);
    });

    it('updates multiple settings at once', () => {
      updateBrowserSettings({
        idleTimeoutMs: 15 * 60 * 1000,
        maxSessions: 8,
        screenshotFormat: 'jpeg'
      });

      const settings = getBrowserSettings();
      expect(settings.idleTimeoutMs).toBe(15 * 60 * 1000);
      expect(settings.maxSessions).toBe(8);
      expect(settings.screenshotFormat).toBe('jpeg');
    });

    it('preserves unmodified settings', () => {
      updateBrowserSettings({ idleTimeoutMs: 20 * 60 * 1000 });

      const settings = getBrowserSettings();
      expect(settings.idleTimeoutMs).toBe(20 * 60 * 1000);
      expect(settings.maxLifetimeMs).toBe(30 * 60 * 1000); // unchanged
      expect(settings.maxSessions).toBe(5); // unchanged
    });
  });

  describe('Validation', () => {
    it('validates idle timeout minimum', () => {
      expect(() => {
        updateBrowserSettings({ idleTimeoutMs: 30 * 1000 }); // 30 seconds
      }).toThrow('Idle timeout must be at least 1 minute');
    });

    it('validates idle timeout maximum', () => {
      expect(() => {
        updateBrowserSettings({ idleTimeoutMs: 2 * 60 * 60 * 1000 }); // 2 hours
      }).toThrow('Idle timeout must be at most 1 hour');
    });

    it('validates max lifetime minimum', () => {
      expect(() => {
        updateBrowserSettings({ maxLifetimeMs: 5 * 60 * 1000 }); // 5 minutes
      }).toThrow('Max lifetime must be at least 10 minutes');
    });

    it('validates max lifetime maximum', () => {
      expect(() => {
        updateBrowserSettings({ maxLifetimeMs: 5 * 60 * 60 * 1000 }); // 5 hours
      }).toThrow('Max lifetime must be at most 4 hours');
    });

    it('validates max sessions minimum', () => {
      expect(() => {
        updateBrowserSettings({ maxSessions: 0 });
      }).toThrow('Max sessions must be between 1 and 20');
    });

    it('validates max sessions maximum', () => {
      expect(() => {
        updateBrowserSettings({ maxSessions: 25 });
      }).toThrow('Max sessions must be between 1 and 20');
    });

    it('validates cleanup interval minimum', () => {
      expect(() => {
        updateBrowserSettings({ cleanupIntervalMs: 10 * 1000 }); // 10 seconds
      }).toThrow('Cleanup interval must be at least 30 seconds');
    });

    it('validates cleanup interval maximum', () => {
      expect(() => {
        updateBrowserSettings({ cleanupIntervalMs: 11 * 60 * 1000 }); // 11 minutes
      }).toThrow('Cleanup interval must be at most 10 minutes');
    });

    it('validates log retention minimum', () => {
      expect(() => {
        updateBrowserSettings({ logRetentionMs: 5 * 60 * 1000 }); // 5 minutes
      }).toThrow('Log retention must be at least 10 minutes');
    });

    it('validates log retention maximum', () => {
      expect(() => {
        updateBrowserSettings({ logRetentionMs: 25 * 60 * 60 * 1000 }); // 25 hours
      }).toThrow('Log retention must be at most 24 hours');
    });

    it('validates screenshot format', () => {
      expect(() => {
        updateBrowserSettings({ screenshotFormat: 'gif' as any });
      }).toThrow('Screenshot format must be png or jpeg');
    });

    it('validates screenshot quality minimum', () => {
      expect(() => {
        updateBrowserSettings({ screenshotQuality: 0 });
      }).toThrow('Screenshot quality must be between 1 and 100');
    });

    it('validates screenshot quality maximum', () => {
      expect(() => {
        updateBrowserSettings({ screenshotQuality: 101 });
      }).toThrow('Screenshot quality must be between 1 and 100');
    });
  });

  describe('Reset Settings', () => {
    it('resets all settings to defaults', () => {
      updateBrowserSettings({
        idleTimeoutMs: 20 * 60 * 1000,
        maxSessions: 10,
        screenshotFormat: 'jpeg',
        screenshotQuality: 75
      });

      let settings = getBrowserSettings();
      expect(settings.idleTimeoutMs).toBe(20 * 60 * 1000);
      expect(settings.maxSessions).toBe(10);

      resetBrowserSettings();

      settings = getBrowserSettings();
      expect(settings.idleTimeoutMs).toBe(5 * 60 * 1000);
      expect(settings.maxLifetimeMs).toBe(30 * 60 * 1000);
      expect(settings.maxSessions).toBe(5);
      expect(settings.cleanupIntervalMs).toBe(60 * 1000);
      expect(settings.logRetentionMs).toBe(60 * 60 * 1000);
      expect(settings.screenshotFormat).toBe('png');
      expect(settings.screenshotQuality).toBe(90);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty update object', () => {
      const beforeSettings = getBrowserSettings();
      updateBrowserSettings({});
      const afterSettings = getBrowserSettings();
      expect(afterSettings).toEqual(beforeSettings);
    });

    it('accepts boundary values', () => {
      updateBrowserSettings({
        idleTimeoutMs: 1 * 60 * 1000, // minimum
        maxLifetimeMs: 10 * 60 * 1000, // minimum
        maxSessions: 1, // minimum
        cleanupIntervalMs: 30 * 1000, // minimum
        logRetentionMs: 10 * 60 * 1000, // minimum
        screenshotQuality: 1 // minimum
      });

      const settings = getBrowserSettings();
      expect(settings.idleTimeoutMs).toBe(1 * 60 * 1000);
      expect(settings.maxLifetimeMs).toBe(10 * 60 * 1000);
      expect(settings.maxSessions).toBe(1);
      expect(settings.cleanupIntervalMs).toBe(30 * 1000);
      expect(settings.logRetentionMs).toBe(10 * 60 * 1000);
      expect(settings.screenshotQuality).toBe(1);
    });

    it('accepts maximum boundary values', () => {
      updateBrowserSettings({
        idleTimeoutMs: 60 * 60 * 1000, // maximum
        maxLifetimeMs: 4 * 60 * 60 * 1000, // maximum
        maxSessions: 20, // maximum
        cleanupIntervalMs: 10 * 60 * 1000, // maximum
        logRetentionMs: 24 * 60 * 60 * 1000, // maximum
        screenshotQuality: 100 // maximum
      });

      const settings = getBrowserSettings();
      expect(settings.idleTimeoutMs).toBe(60 * 60 * 1000);
      expect(settings.maxLifetimeMs).toBe(4 * 60 * 60 * 1000);
      expect(settings.maxSessions).toBe(20);
      expect(settings.cleanupIntervalMs).toBe(10 * 60 * 1000);
      expect(settings.logRetentionMs).toBe(24 * 60 * 60 * 1000);
      expect(settings.screenshotQuality).toBe(100);
    });
  });
});
