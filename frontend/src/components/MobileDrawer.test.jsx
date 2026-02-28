import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileDrawer } from './MobileDrawer';

function buildProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onCreateSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenApiSettings: vi.fn(),
    onOpenBrowserSettings: vi.fn(),
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    onOpenProcessManager: vi.fn(),
    projects: [],
    projectsLoading: false,
    onFolderSelect: vi.fn(),
    currentPath: '',
    onAddScanFolder: vi.fn(),
    onNavigateToPath: vi.fn(),
    mobileView: 'terminal',
    onViewChange: vi.fn(),
    previewUrl: '',
    inactiveSessions: [],
    onRestoreSession: vi.fn(),
    activeSessions: [],
    activeSessionId: null,
    sessionActivity: {},
    onSelectSession: vi.fn(),
    sessionsGroupedByProject: [],
    ...overrides
  };
}

describe('MobileDrawer', () => {
  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(<MobileDrawer {...buildProps({ onClose })} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on left swipe gesture', () => {
    const onClose = vi.fn();
    const { container } = render(<MobileDrawer {...buildProps({ onClose })} />);
    const drawer = container.querySelector('.mobile-drawer-modern');
    expect(drawer).toBeTruthy();

    fireEvent.touchStart(drawer, {
      touches: [{ clientX: 220, clientY: 120 }]
    });
    fireEvent.touchEnd(drawer, {
      changedTouches: [{ clientX: 140, clientY: 126 }]
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus within the drawer when tabbing', () => {
    const { container } = render(<MobileDrawer {...buildProps()} />);
    const drawer = container.querySelector('.mobile-drawer-modern');
    expect(drawer).toBeTruthy();

    const selector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const focusable = Array.from(drawer.querySelectorAll(selector));
    expect(focusable.length).toBeGreaterThan(1);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores focus to the previously focused element when closing', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open drawer';
    document.body.appendChild(trigger);
    trigger.focus();

    const props = buildProps({ isOpen: true });
    const { rerender } = render(<MobileDrawer {...props} />);

    rerender(<MobileDrawer {...props} isOpen={false} />);
    expect(trigger).toHaveFocus();

    trigger.remove();
  });

  it('exposes dialog semantics while open', () => {
    render(<MobileDrawer {...buildProps()} />);

    expect(screen.getByRole('dialog', { name: /mobile menu/i })).toBeInTheDocument();
  });

  it('toggles gesture help content from footer button', () => {
    render(<MobileDrawer {...buildProps()} />);

    fireEvent.click(screen.getByRole('button', { name: /show mobile gesture help/i }));
    expect(screen.getByText('Swipe right from the left edge to open the drawer.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show mobile gesture help/i }));
    expect(screen.queryByText('Swipe right from the left edge to open the drawer.')).not.toBeInTheDocument();
  });
});
