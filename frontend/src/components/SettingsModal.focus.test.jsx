import { useState } from 'react';
import { createPortal } from 'react-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../utils/api';

function props(overrides = {}) {
  return {
    isOpen: true,
    sessionId: 'pty-focus-fixture',
    currentCwd: '/focus-fixture',
    recentFolders: [],
    terminalFontSize: 14,
    onClose: vi.fn(),
    onSave: vi.fn(),
    onAddRecentFolder: vi.fn(),
    ...overrides,
  };
}

function SettingsLauncher() {
  const [isOpen, setIsOpen] = useState(false);
  return <>
    <button onClick={() => setIsOpen(true)}>Open settings</button>
    <button>Behind settings</button>
    <SettingsModal {...props({ isOpen, onClose: () => setIsOpen(false) })} />
  </>;
}

describe('SettingsModal focus lifecycle', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ path: '/focus-fixture', folders: [], parent: null }),
    });
  });

  it('focuses Close on every opening and restores the opener after Escape', async () => {
    const user = userEvent.setup();
    render(<SettingsLauncher />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    for (const opening of ['first', 'second']) {
      await user.click(opener);
      expect(screen.getByRole('button', { name: 'Close', exact: true }), opening).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: 'Session Settings' }), opening).not.toBeInTheDocument();
      expect(opener, opening).toHaveFocus();
    }
  });

  it('wraps Shift+Tab and Tab without visiting hidden section controls', async () => {
    const user = userEvent.setup();
    render(<SettingsModal {...props()} />);
    const close = screen.getByRole('button', { name: 'Close', exact: true });
    close.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Done', exact: true })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Processes' }));
    close.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Done', exact: true })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel', exact: true })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Setup check', exact: true })).toHaveFocus();
  });

  it('dismisses Settings with Escape from a form control and restores the opener', async () => {
    const user = userEvent.setup();
    render(<SettingsLauncher />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    await user.click(opener);
    screen.getByRole('textbox', { name: 'Working Directory' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Session Settings' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('excludes disabled controls from the focus boundary while navigation is pending', async () => {
    const user = userEvent.setup();
    let finishNavigation;
    const options = props({ onSave: vi.fn(() => new Promise(resolve => { finishNavigation = resolve; })) });
    render(<SettingsModal {...options} />);
    await user.type(screen.getByRole('textbox', { name: 'Working Directory' }), '/next');
    await user.click(screen.getByRole('button', { name: 'Save & Navigate' }));
    const close = screen.getByRole('button', { name: 'Close', exact: true });
    close.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel', exact: true })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await act(async () => finishNavigation());
  });

  it('contains attempted background focus and preserves the last focused settings control', async () => {
    const user = userEvent.setup();
    render(<SettingsLauncher />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    const directory = screen.getByRole('textbox', { name: 'Working Directory' });
    directory.focus();
    screen.getByRole('button', { name: 'Behind settings' }).focus();
    expect(directory).toHaveFocus();
  });

  it('restores focus on unmount and does not refocus when session props or callbacks change', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    try {
      opener.focus();
      const options = props();
      const { rerender, unmount } = render(<SettingsModal {...options} />);
      const directory = screen.getByRole('textbox', { name: 'Working Directory' });
      directory.focus();
      rerender(<SettingsModal {...options} sessionId="pty-other-fixture" currentCwd="/other-fixture" onClose={vi.fn()} />);
      expect(directory).toHaveFocus();
      unmount();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
    }
  });

  it('lets the real portaled folder browser own focus and Escape before returning to Settings', async () => {
    const user = userEvent.setup();
    render(<SettingsLauncher />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    await user.click(opener);
    const settings = screen.getByRole('dialog', { name: 'Session Settings' });
    const browse = within(settings).getByRole('button', { name: 'Browse' });
    await user.click(browse);
    const folderBrowser = screen.getByRole('dialog', { name: 'Choose project' });
    expect(settings).not.toContainElement(folderBrowser);
    const search = within(folderBrowser).getByRole('textbox', { name: 'Search folders' });
    expect(search).toHaveFocus();
    await user.tab();
    expect(within(folderBrowser).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Choose project' })).not.toBeInTheDocument();
    expect(settings).toBeVisible();
    expect(browse).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Session Settings' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/fs/list?path=%2Ffocus-fixture']);
  });

  it('preserves folder-browser focus when retained Settings is closed and reopened', async () => {
    const user = userEvent.setup();
    const options = props();
    const { rerender } = render(<SettingsModal {...options} />);
    await user.click(screen.getByRole('button', { name: 'Browse' }));
    expect(screen.getByRole('textbox', { name: 'Search folders' })).toHaveFocus();
    rerender(<SettingsModal {...options} isOpen={false} />);
    rerender(<SettingsModal {...options} />);
    expect(screen.getByRole('textbox', { name: 'Search folders' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Choose project' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Session Settings' })).toBeVisible();
    expect(options.onClose).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'alertdialog', 'native'])('does not take focus from an overlaid %s during use or Settings dismissal', kind => {
    const options = props();
    function Surface({ isOpen }) {
      const content = <button>Nested action</button>;
      return <>
        <button>Original opener</button>
        <SettingsModal {...options} isOpen={isOpen} />
        {createPortal(kind === 'native' ? <dialog open>{content}</dialog> : <div role={kind}>{content}</div>, document.body)}
      </>;
    }
    const { rerender } = render(<Surface isOpen={false} />);
    screen.getByRole('button', { name: 'Original opener' }).focus();
    rerender(<Surface isOpen />);
    const nested = screen.getByRole('button', { name: 'Nested action' });
    nested.focus();
    expect(nested).toHaveFocus();
    rerender(<Surface isOpen={false} />);
    expect(nested).toHaveFocus();
    expect(options.onClose).not.toHaveBeenCalled();
  });
});
