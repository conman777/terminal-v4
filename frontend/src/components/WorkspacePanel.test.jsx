import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspacePanel } from './WorkspacePanel';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1200 });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 10, height: 10 }]);
});
afterEach(() => vi.restoreAllMocks());

describe('WorkspacePanel', () => {
  it('remembers a keyboard-resized navigation width and clamps its extremes', () => {
    const view = render(<WorkspacePanel kind="navigation">Threads</WorkspacePanel>);
    const separator = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(separator).toHaveAttribute('aria-valuenow', '256');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '280');
    view.unmount();
    render(<WorkspacePanel kind="navigation">Threads</WorkspacePanel>);
    const restored = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(restored).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(restored, { key: 'End' });
    expect(restored).toHaveAttribute('aria-valuenow', '560');
    fireEvent.keyDown(restored, { key: 'Home' });
    expect(restored).toHaveAttribute('aria-valuenow', '208');
  });

  it('resizes the browser in the opposite direction and preserves its contents when expanded', () => {
    const view = render(<WorkspacePanel kind="tools"><input aria-label="Retained draft" defaultValue="saved" /></WorkspacePanel>);
    const input = screen.getByLabelText('Retained draft');
    const separator = screen.getByRole('separator', { name: 'Resize browser panel' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '564');
    view.rerender(<WorkspacePanel kind="tools" expanded><input aria-label="Retained draft" defaultValue="saved" /></WorkspacePanel>);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Retained draft')).toBe(input);
    expect(input).toHaveValue('saved');
  });

  it('restores valid wide-screen preferences rather than discarding them', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 2560 });
    const view = render(<WorkspacePanel kind="navigation">Threads</WorkspacePanel>);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '1792');
    view.unmount();
    render(<WorkspacePanel kind="navigation">Threads</WorkspacePanel>);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '1792');
  });

  it('reserves room for both chat and an inline browser when navigation is resized', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 1024 });
    render(<WorkspacePanel kind="navigation" reserveSpace={720}>Threads</WorkspacePanel>);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '304');
  });

  it('focuses a lazy sheet fallback and transfers focus when its controls load', async () => {
    const view = render(<WorkspacePanel kind="tools" forceSheet>Loading browser…</WorkspacePanel>);
    expect(screen.getByRole('dialog')).toHaveFocus();
    view.rerender(<WorkspacePanel kind="tools" forceSheet><button>Close browser</button></WorkspacePanel>);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Close browser', exact: true })).toHaveFocus());
  });

  it('uses a dismissible keyboard-accessible tool sheet without unmounting the conversation', () => {
    const close = vi.fn();
    render(<><div data-testid="conversation"><input aria-label="Chat draft" defaultValue="keep" /></div><WorkspacePanel kind="tools" forceSheet onClose={close}><button>Browser action</button></WorkspacePanel></>);
    const dialog = screen.getByRole('dialog', { name: 'Browser panel' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('conversation')).toHaveAttribute('inert');
    expect(screen.getByLabelText('Chat draft')).toHaveValue('keep');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('suspends sheet focus and background blocking while covered, then restores them with the same browser nodes', () => {
    const close = vi.fn();
    const content = covered => <>
      <nav aria-label="Workspace navigation"><button>Settings</button></nav>
      <WorkspacePanel kind="tools" forceSheet covered={covered} onClose={close}><input aria-label="Browser address" defaultValue="https://synthetic.invalid" /></WorkspacePanel>
    </>;
    const view = render(content(false));
    const address = screen.getByRole('textbox', { name: 'Browser address' });
    const panel = screen.getByRole('dialog', { name: 'Browser panel' });
    const navigation = screen.getByRole('navigation');
    expect(navigation).toHaveAttribute('inert');

    view.rerender(content(true));
    expect(navigation).not.toHaveAttribute('inert');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close browser backdrop' })).not.toBeInTheDocument();
    const settings = screen.getByRole('button', { name: 'Settings' });
    settings.focus();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(settings).toHaveFocus();

    view.rerender(content(false));
    expect(screen.getByRole('dialog', { name: 'Browser panel' })).toBe(panel);
    expect(screen.getByRole('textbox', { name: 'Browser address' })).toBe(address);
    expect(address).toHaveFocus();
    expect(navigation).toHaveAttribute('inert');
  });
});
