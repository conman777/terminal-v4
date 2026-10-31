import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

const state = vi.hoisted(() => ({ auth: null, desktop: null, mobile: null, provider: null }));
vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => state.auth,
  useOptionalAuth: () => state.auth,
}));
vi.mock('./components/SplitPaneContainer', () => ({
  SplitPaneContainer: props => { state.desktop = props; return <div data-testid="strict-desktop" />; },
}));
vi.mock('./components/MobileShell', () => ({
  MobileShell: props => { state.mobile = props; return <div data-testid="strict-mobile" />; },
}));
vi.mock('./contexts/TerminalSessionContext', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, TerminalSessionProvider: props => { state.provider = props; return <actual.TerminalSessionProvider {...props} />; } };
});

let fixture;
let previousViewport;
afterEach(() => { cleanup(); fixture?.restore(); if (previousViewport) Object.defineProperty(window, 'visualViewport', previousViewport); else delete window.visualViewport; previousViewport = undefined; state.desktop = null; state.mobile = null; state.provider = null; });

it('omits strict props for the legacy desktop workspace', async () => {
  fixture = installSelectionPaneR1Fixture();
  state.auth = { user: { id: R1.owner, username: R1.username }, isAuthenticated: true, loading: false, logout: vi.fn() };
  render(<App />);
  await screen.findByTestId('strict-desktop');
  expect([Object.hasOwn(state.desktop, 'authLifecycle'), Object.hasOwn(state.desktop, 'strictReady')]).toEqual([false, false]);
});

it('forwards unavailable strict authority without falling back on desktop and mobile', async () => {
  fixture = installSelectionPaneR1Fixture();
  state.auth = { user: { id: R1.owner, username: R1.username }, isAuthenticated: true, loading: false, logout: vi.fn(), authLifecycle: undefined, strictReady: false };
  const desktop = render(<App />);
  await screen.findByRole('region', { name: 'Session loading problem' });
  expect([Object.hasOwn(state.provider, 'authLifecycle'), state.provider.authLifecycle, state.provider.strictReady, screen.queryByTestId('strict-desktop')]).toEqual([true, undefined, false, null]);
  desktop.unmount();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 390, height: 800, addEventListener() {}, removeEventListener() {} } });
  render(<App />);
  await screen.findByTestId('strict-mobile');
  expect([Object.hasOwn(state.mobile, 'authLifecycle'), state.mobile.authLifecycle, state.mobile.strictReady]).toEqual([true, undefined, false]);
});
