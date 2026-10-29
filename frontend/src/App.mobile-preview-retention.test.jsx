import { afterEach, describe, expect, it, vi } from 'vitest';
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
  PreviewPanel: ({ url, onClose }) => <section aria-label="Preview panel"><input aria-label="Preview location" defaultValue={url} /><button onClick={onClose}>Close Preview</button></section>,
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


describe('Mobile Preview retention and tablet keyboard geometry', () => {
  it('keeps the draft through mobile navigation and restores it after signing back in', async () => {
    await openWorkspace({ width: 390, touch: true });
    const composer = screen.getByRole('textbox', { name: 'Command composer', exact: true });
    fireEvent.change(composer, { target: { value: 'Keep this unsent draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(composer).toHaveValue('Keep this unsent draft');
    const originalFetch = window.fetch;
    const logout = vi.fn(async () => new Response(JSON.stringify({ success: true, cleanup: { state: 'pending' } }), { status: 202, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', (input, options) => new URL(typeof input === 'string' ? input : input.url, window.location.href).pathname === '/api/auth/logout' ? logout(input, options) : originalFetch(input, options));
    fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out', exact: true }));
    expect(await screen.findByText(/server cleanup is still pending/i)).toBeVisible();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(fixture.sendCalls()).toEqual([]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    expect(await screen.findByRole('textbox', { name: 'Command composer', exact: true })).toHaveValue('Keep this unsent draft');
  });
  it('returns to the retained conversation when mobile Preview Close is pressed', async () => {
    await openWorkspace({ width: 390, touch: true }, true);
    const composer = screen.getByRole('textbox', { name: 'Command composer', exact: true });
    fireEvent.change(composer, { target: { value: 'keep this follow-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview', exact: true }));
    const close = await screen.findByRole('button', { name: 'Close Preview', exact: true });
    close.focus(); fireEvent.click(close);
    expect(await screen.findByRole('textbox', { name: 'Command composer', exact: true })).toBe(composer);
    expect(composer).toHaveValue('keep this follow-up');
    expect(screen.queryByRole('textbox', { name: 'Preview location' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Menu', exact: true })).toHaveFocus());
    expect(fixture.sendCalls()).toEqual([]);
  });
  it.each([800, 1024])('sizes the desktop tablet workspace to an overlay keyboard viewport at %ipx', async width => {
    const { container } = await openWorkspace({ width, touch: true });
    const composer = screen.getByRole('textbox', { name: 'Command composer', exact: true });
    composer.focus();
    window.visualViewport.height = 402;
    window.visualViewport.offsetTop = 248;
    fireEvent.focusIn(composer);
    fireEvent.resize(window);
    await waitFor(() => {
      const layout = container.querySelector('.layout');
      expect({ mobile: layout.classList.contains('mobile'), viewport: layout.style.getPropertyValue('--mobile-viewport-height'), top: layout.style.getPropertyValue('--mobile-viewport-offset') }).toEqual({ mobile: false, viewport: '402px', top: '248px' });
    });
    expect(screen.getByRole('textbox', { name: 'Command composer', exact: true })).toBe(composer);
    expect(fixture.sendCalls()).toEqual([]);
  });
  it.each([320,390,768])('retains mobile conversation nodes when Preview opens at %ipx', async width => {
    const {container} = await openWorkspace({width,touch:true}, true);
    const composer=screen.getByRole('textbox',{name:'Command composer',exact:true});
    const host=container.querySelector('[data-persistent-terminal]');
    fireEvent.change(composer,{target:{value:'review retained draft'}});
    fireEvent.click(screen.getByRole('button',{name:'Menu',exact:true}));
    fireEvent.click(await screen.findByRole('button',{name:'Preview',exact:true}));
    await screen.findByRole('textbox',{name:'Preview location'});
    expect({composerConnected:composer.isConnected,terminalHostConnected:host.isConnected}).toEqual({composerConnected:true,terminalHostConnected:true});
    expect(composer.closest('[inert]')).not.toBeNull();
    expect(composer.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('textbox',{name:'Command composer',exact:true})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Menu',exact:true}));
    fireEvent.click(await screen.findByRole('button',{name:'Workspace',exact:true}));
    expect(await screen.findByRole('textbox',{name:'Command composer',exact:true})).toBe(composer);
    expect(composer).toHaveValue('review retained draft');
    expect(composer.closest('[inert]')).toBeNull();
  });
  it('opens a selected thread from Preview and retains its draft', async () => {
    await openWorkspace({ width: 320, touch: true }, true);
    const composer = screen.getByRole('textbox', { name: 'Command composer', exact: true });
    const originalDraft = composer.value;
    fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview', exact: true }));
    await screen.findByRole('textbox', { name: 'Preview location' });
    fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: /R1 amber notebook/ }));
    expect(await screen.findByRole('textbox', { name: 'Command composer', exact: true })).toBe(composer);
    expect(composer).toHaveValue(originalDraft);
    expect(fixture.sendCalls()).toEqual([]);
  });

  it('retains the new-task draft across mobile Preview and back', async () => {
    await openWorkspace({width:390,touch:true}, true);
    fireEvent.click(screen.getByRole('button',{name:'More actions',exact:true}));
    fireEvent.click(await screen.findByRole('button',{name:'New thread',exact:true}));
    const composer=screen.getByRole('textbox',{name:'Command composer',exact:true});
    fireEvent.change(composer,{target:{value:'new task before preview'}});
    fireEvent.click(screen.getByRole('button',{name:'Menu',exact:true}));
    fireEvent.click(await screen.findByRole('button',{name:'Preview',exact:true}));
    await screen.findByRole('textbox',{name:'Preview location'});
    fireEvent.click(screen.getByRole('button',{name:'Menu',exact:true}));
    fireEvent.click(await screen.findByRole('button',{name:'Workspace',exact:true}));
    expect(await screen.findByRole('textbox',{name:'Command composer',exact:true})).toHaveValue('new task before preview');
  });
});
