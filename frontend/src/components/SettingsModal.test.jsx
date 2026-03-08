import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';

vi.mock('./FolderBrowserModal', () => ({
  FolderBrowserModal: () => null,
}));

vi.mock('../utils/auth', () => ({
  getAccessToken: () => null,
}));

function buildProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    sessionId: 'session-1',
    sessionTitle: 'Terminal 1',
    currentCwd: '/workspace',
    recentFolders: [],
    onSave: vi.fn(),
    onAddRecentFolder: vi.fn(),
    terminalFontSize: 14,
    onFontSizeChange: vi.fn(),
    terminalWebglEnabled: true,
    onWebglChange: vi.fn(),
    showTabStatusLabels: true,
    onTabStatusLabelsChange: vi.fn(),
    ...overrides,
  };
}

function withNavigator(navigatorLike, testFn) {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: navigatorLike,
  });
  try {
    testFn();
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }
}

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the WebGL renderer toggle on Linux desktops', () => {
    withNavigator(
      {
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        platform: 'Linux x86_64',
      },
      () => {
        const onWebglChange = vi.fn();
        render(<SettingsModal {...buildProps({ onWebglChange })} />);

        const webglButton = screen.getByRole('button', { name: 'WebGL' });
        const canvasButton = screen.getByRole('button', { name: 'Canvas' });

        expect(webglButton).toBeDisabled();
        expect(canvasButton).toHaveClass('active');

        fireEvent.click(webglButton);
        expect(onWebglChange).not.toHaveBeenCalled();
        expect(
          screen.getByText(/disabled on linux desktops/i)
        ).toBeInTheDocument();
      }
    );
  });
});
