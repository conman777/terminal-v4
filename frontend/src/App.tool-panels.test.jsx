import { it, expect, vi } from 'vitest';
import { openSidebarApp } from './test/sidebarApps.js';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

vi.mock('./components/WorkspaceBrowser', () => ({ default: ({ onClose }) => <section aria-label="Workspace browser"><button onClick={onClose}>Close browser pane</button></section> }));
vi.mock('./components/PreviewPanel', () => ({ PreviewPanel: () => <section aria-label="Preview panel" /> }));
vi.mock('./components/SettingsModal', () => ({ SettingsModal: ({ isOpen, onOpenSystemResources }) => isOpen ? <button onClick={onOpenSystemResources}>Show system resources</button> : null }));
vi.mock('./components/SystemResourcesView', () => ({ SystemResourcesView: () => <section aria-label="System resources" /> }));

it('places the mobile server selector in navigation without a separate top bar', async () => {
  const fixture = installSelectionPaneR1Fixture();
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const viewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 390, height: 844, addEventListener() {}, removeEventListener() {} } });
  const host = document.createElement('div'); document.body.append(host);
  try {
    render(<App />, { container: host });
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Menu' }));
    const selector = await screen.findByRole('button', { name: 'Switch server, This server' });
    expect(selector.closest('.mobile-drawer-modern')).not.toBeNull();
    expect(host.querySelector('.remote-environment-bar')).toBeNull();
  } finally {
    cleanup(); host.remove(); fixture.restore();
    if (width) Object.defineProperty(window, 'innerWidth', width);
    if (viewport) Object.defineProperty(window, 'visualViewport', viewport);
  }
});

it('switches from Browser to Preview through the same keyboard action as the sidebar', async () => {
  const fixture = installSelectionPaneR1Fixture();
  const host = document.createElement('div'); document.body.append(host);
  try {
    render(<App />, { container: host });
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle browser pane' }));
    await waitFor(() => expect(host.querySelector('.main-content')).toHaveClass('with-browser'));
    fireEvent.keyDown(document.body, { key: 'p', metaKey: true, ctrlKey: true });
    await waitFor(() => expect(host.querySelector('.main-content')).toHaveClass('with-preview'));
    expect(host.querySelector('.main-content')).not.toHaveClass('with-browser');
    expect(fixture.sendCalls()).toEqual([]);
  } finally { cleanup(); host.remove(); fixture.restore(); }
});

it.each([{ wasOpen: false, mode: 'fullscreen' }, { wasOpen: true, mode: 'fullscreen' }, { wasOpen: false, mode: 'resources' }, { wasOpen: true, mode: 'resources' }, { wasOpen: false, mode: 'resources', entry: 'sidebar' }, { wasOpen: true, mode: 'resources', entry: 'sidebar' }])('opens Browser from $mode via $entry when already open=$wasOpen', async ({ wasOpen, mode, entry = 'approval' }) => {
  const fixture = installSelectionPaneR1Fixture();
  const fixtureFetch = globalThis.fetch;
  let requests = wasOpen ? [] : [{ id: 'synthetic-request' }];
  vi.stubGlobal('fetch', vi.fn((input, options) => {
    if (String(input).includes('/api/workspace-browser/approvals')) return Promise.resolve(new Response(JSON.stringify({ requests }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return fixtureFetch(input, options);
  }));
  const host = document.createElement('div'); document.body.append(host);
  try {
    render(<App />, { container: host });
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    if (wasOpen) {
      fireEvent.click(await screen.findByRole('button', { name: 'Toggle browser pane', exact: true }));
      await screen.findByRole('region', { name: 'Workspace browser' });
    }
    requests = [{ id: 'synthetic-request' }];
    if (mode === 'fullscreen') {
      fireEvent.click(await screen.findByRole('button', { name: 'Fullscreen', exact: true }));
      expect(await screen.findByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Settings', exact: true }));
      fireEvent.click(await screen.findByRole('button', { name: 'Show system resources', exact: true }));
      expect(await screen.findByRole('region', { name: 'System resources' })).toBeVisible();
    }
    fireEvent.click(entry === 'sidebar' ? await openSidebarApp('Browser') : await screen.findByRole('button', { name: 'Review browser request (1)', exact: true }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Exit fullscreen', exact: true })).not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'System resources' })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Workspace browser' })).toBeVisible();
    expect(host.querySelector('.main-content')).toHaveClass('with-browser');
    expect(fixture.sendCalls()).toEqual([]);
  } finally { cleanup(); host.remove(); fixture.restore(); }
});

it('returns focus to the mobile menu trigger after its Browser item has unmounted', async () => {
  const fixture = installSelectionPaneR1Fixture();
  const viewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 390, height: 844, addEventListener() {}, removeEventListener() {} } });
  const host = document.createElement('div'); document.body.append(host);
  try {
    render(<App />, { container: host });
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Menu', exact: true }));
    const item = await screen.findByRole('button', { name: 'Browser', exact: true });
    item.focus(); fireEvent.click(item);
    fireEvent.click(await screen.findByRole('button', { name: 'Close browser pane', exact: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Menu', exact: true })).toHaveFocus());
    expect(fixture.sendCalls()).toEqual([]);
  } finally {
    cleanup(); host.remove(); fixture.restore();
    if (viewport) Object.defineProperty(window, 'visualViewport', viewport);
  }
});
