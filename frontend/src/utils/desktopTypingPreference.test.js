import { describe, expect, it } from 'vitest';

import {
  DESKTOP_TERMINAL_INPUT_MIGRATION_KEY,
  DESKTOP_TERMINAL_INPUT_MIGRATION_VERSION,
  DESKTOP_TERMINAL_INPUT_STORAGE_KEY,
  resolveDesktopTerminalInputPreference,
} from './desktopTypingPreference';

function createStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

describe('resolveDesktopTerminalInputPreference', () => {
  it('resets legacy saved terminal input preferences to composer-only once', () => {
    const storage = createStorage({
      [DESKTOP_TERMINAL_INPUT_STORAGE_KEY]: 'true',
    });

    expect(resolveDesktopTerminalInputPreference(storage)).toEqual({
      value: false,
      didResetLegacyPreference: true,
    });
    expect(storage.getItem(DESKTOP_TERMINAL_INPUT_STORAGE_KEY)).toBe('false');
    expect(storage.getItem(DESKTOP_TERMINAL_INPUT_MIGRATION_KEY)).toBe(
      DESKTOP_TERMINAL_INPUT_MIGRATION_VERSION
    );
  });

  it('preserves the saved preference after the migration marker is present', () => {
    const storage = createStorage({
      [DESKTOP_TERMINAL_INPUT_STORAGE_KEY]: 'true',
      [DESKTOP_TERMINAL_INPUT_MIGRATION_KEY]: DESKTOP_TERMINAL_INPUT_MIGRATION_VERSION,
    });

    expect(resolveDesktopTerminalInputPreference(storage)).toEqual({
      value: true,
      didResetLegacyPreference: false,
    });
  });

  it('falls back to composer-only when storage is unavailable', () => {
    expect(resolveDesktopTerminalInputPreference(null)).toEqual({
      value: false,
      didResetLegacyPreference: false,
    });
  });
});
