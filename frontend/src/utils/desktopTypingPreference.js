export const DESKTOP_TERMINAL_INPUT_STORAGE_KEY = 'desktopAllowTerminalInput';
export const DESKTOP_TERMINAL_INPUT_MIGRATION_KEY = 'desktopAllowTerminalInputMigration';
export const DESKTOP_TERMINAL_INPUT_MIGRATION_VERSION = '2026-04-composer-only-default';

export function resolveDesktopTerminalInputPreference(storage = globalThis?.localStorage) {
  if (!storage) {
    return { value: false, didResetLegacyPreference: false };
  }

  try {
    const migrationVersion = storage.getItem(DESKTOP_TERMINAL_INPUT_MIGRATION_KEY);
    if (migrationVersion !== DESKTOP_TERMINAL_INPUT_MIGRATION_VERSION) {
      storage.setItem(DESKTOP_TERMINAL_INPUT_STORAGE_KEY, 'false');
      storage.setItem(
        DESKTOP_TERMINAL_INPUT_MIGRATION_KEY,
        DESKTOP_TERMINAL_INPUT_MIGRATION_VERSION
      );
      return { value: false, didResetLegacyPreference: true };
    }

    return {
      value: storage.getItem(DESKTOP_TERMINAL_INPUT_STORAGE_KEY) === 'true',
      didResetLegacyPreference: false,
    };
  } catch {
    return { value: false, didResetLegacyPreference: false };
  }
}
