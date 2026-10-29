import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSidebarApp } from './test/sidebarApps.js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';
import { getEnvironmentStorage } from './utils/remoteEnvironments';

vi.mock('./components/SettingsModal', () => ({
  SettingsModal: ({ isOpen, onOpenSystemResources }) => isOpen
    ? <button onClick={onOpenSystemResources}>Show system resources</button> : null,
}));
vi.mock('./components/SystemResourcesView', () => ({
  SystemResourcesView: ({ onClose }) => <section aria-label="Synthetic resource metrics"><button onClick={onClose}>Back to workspace</button></section>,
}));
vi.mock('./components/WorkspaceBrowser', () => ({
  default: ({ onClose, onToggleExpanded }) => <section aria-label="Workspace browser">
    <input aria-label="Browser address" defaultValue="https://synthetic.invalid/retained" />
    {onToggleExpanded && <button onClick={onToggleExpanded}>Expand browser pane</button>}
    <button onClick={onClose}>Close browser pane</button>
  </section>,
}));
vi.mock('./components/PreviewPanel', () => ({
  PreviewPanel: ({ url }) => <section aria-label="Preview panel"><input aria-label="Preview location" defaultValue={url} /></section>,
}));

const profiles = [
  { width: 1440, touch: false }, { width: 800, touch: false },
  { width: 1024, touch: true }, { width: 390, touch: true },
];
const draft = 'Synthetic unsent new-task draft retained through Resources';
let fixture;
let priorViewport;

afterEach(() => {
  cleanup();
  fixture?.restore();
  if (priorViewport) Object.defineProperty(window, 'visualViewport', priorViewport);
});

async function openWorkspace({ width, touch }, withPreview = false) {
  fixture = installSelectionPaneR1Fixture();
  if (withPreview) getEnvironmentStorage().setItem('terminal_preview_url', 'https://synthetic.invalid/preview');
  priorViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width, height: 900, addEventListener() {}, removeEventListener() {} } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', query => ({
    matches: query.includes('980px') ? width <= 980 : /coarse|hover: none/.test(query) && touch,
    media: query, addEventListener() {}, removeEventListener() {},
  }));
  const view = render(<App />);
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
  fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
  await screen.findByRole('textbox', { name: 'Command composer', exact: true });
  return view;
}

async function openSettings(width) {
  if (width <= 768) fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Settings', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Show system resources', exact: true }));
  await screen.findByRole('button', { name: 'Back to workspace', exact: true });
}

describe('App workspace retention while System Resources is open', () => {
  it.each(profiles)('retains the actual new-task composer and draft at $width (touch=$touch)', async profile => {
    const { container } = await openWorkspace(profile);
    if (profile.width <= 768) fireEvent.click(screen.getByRole('button', { name: 'More actions', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'New thread', exact: true }));
    const start = await screen.findByRole('region', { name: 'Workspace start' });
    const composer = within(start).getByRole('textbox', { name: 'Command composer', exact: true });
    fireEvent.change(composer, { target: { value: draft } });
    composer.focus();
    await openSettings(profile.width);

    expect(composer).toBeInTheDocument();
    expect(composer.closest('[inert]')).not.toBeNull();
    expect(composer.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Workspace start' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'System Resources', exact: true })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer', exact: true })).toBe(composer));
    expect(composer).toHaveValue(draft);
    expect(composer.closest('[inert]')).toBeNull();
    await waitFor(() => expect(composer).toHaveFocus());
    expect(container.querySelectorAll('.workspace-start-view')).toHaveLength(1);
    expect(fixture.sendCalls()).toEqual([]);
  });

  it.each(profiles)('retains the conversation, composer and browser nodes at $width (touch=$touch)', async profile => {
    const { container } = await openWorkspace(profile);
    const composer = screen.getByRole('textbox', { name: 'Command composer', exact: true });
    const conversation = container.querySelector('.desktop-conversation-view');
    const terminalHost = container.querySelector('[data-persistent-terminal]');
    expect(conversation).toBeInTheDocument();
    expect(terminalHost).toBeInTheDocument();
    fireEvent.change(composer, { target: { value: draft } });
    if (profile.width <= 768) fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: profile.width <= 768 ? 'Browser' : 'Toggle browser pane', exact: true }));
    const address = await screen.findByRole('textbox', { name: 'Browser address' });
    if (profile.width === 1440) fireEvent.click(screen.getByRole('button', { name: 'Expand browser pane' }));
    // The sheet normally makes Settings inaccessible. The same public settings
    // handler can still run while Browser is open (for example, a shortcut).
    if (profile.width <= 768) {
      fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true, hidden: true }));
      fireEvent.click(await screen.findByRole('button', { name: 'Settings', exact: true, hidden: true }));
    } else fireEvent.click(screen.getAllByRole('button', { name: 'Settings', exact: true, hidden: true })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Show system resources', exact: true, hidden: true }));
    await screen.findByRole('button', { name: 'Back to workspace' });

    expect([composer.isConnected, conversation.isConnected, terminalHost.isConnected, address.isConnected]).toEqual([true, true, true, true]);
    expect(address.closest('[inert]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Workspace browser' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Browser panel' })).not.toBeInTheDocument();
    if (profile.width > 768) expect(container.querySelector('.workspace-panel-navigation').closest('[inert]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }));
    expect(await screen.findByRole('textbox', { name: 'Browser address' })).toBe(address);
    expect(container.querySelector('.desktop-conversation-view')).toBe(conversation);
    expect(container.querySelector('[data-persistent-terminal]')).toBe(terminalHost);
    expect(composer).toHaveValue(draft);
    expect(fixture.sendCalls()).toEqual([]);
  });

  it.each([profiles[0], profiles[3]])('retains an open Preview across Resources at $width', async profile => {
    await openWorkspace(profile, true);
    if (profile.width <= 768) fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(profile.width <= 768 ? await screen.findByRole('button', { name: 'Preview', exact: true }) : await openSidebarApp('Preview'));
    const location = await screen.findByRole('textbox', { name: 'Preview location' });
    fireEvent.change(location, { target: { value: 'https://synthetic.invalid/unsaved-location' } });
    await openSettings(profile.width);
    expect(location).toBeInTheDocument();
    expect(location.closest('[inert]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Preview panel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }));
    expect(await screen.findByRole('textbox', { name: 'Preview location' })).toBe(location);
    expect(location).toHaveValue('https://synthetic.invalid/unsaved-location');
    expect(fixture.sendCalls()).toEqual([]);
  });

  it('restores the same fullscreen conversation after closing Resources', async () => {
    const { container } = await openWorkspace(profiles[0]);
    const composer = screen.getByRole('textbox', { name: 'Command composer', exact: true });
    const terminalHost = container.querySelector('[data-persistent-terminal]');
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen', exact: true }));
    await openSettings(profiles[0].width);
    expect(terminalHost).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }));
    expect(await screen.findByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Command composer', exact: true })).toBe(composer);
    expect(container.querySelector('[data-persistent-terminal]')).toBe(terminalHost);
    expect(fixture.sendCalls()).toEqual([]);
  });
});
