import { expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

it.each([1440, 390])('opens a shell-only launcher from New terminal at %ipx', async width => {
  const fixture = installSelectionPaneR1Fixture();
  const previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width, height: 844, addEventListener() {}, removeEventListener() {} } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  try {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    if (width <= 768) fireEvent.click(await screen.findByRole('button', { name: 'Menu', exact: true }));
    const navigation = width <= 768 ? screen.getByRole('dialog', { name: 'Mobile menu' }) : await screen.findByRole('complementary', { name: 'Threads' });
    fireEvent.click(within(navigation).getByRole('button', { name: 'New terminal', exact: true }));
    const dialog = await screen.findByRole('dialog', { name: 'New terminal', exact: true });
    expect(dialog.querySelector('#folder-browser-ai-select')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open terminal', exact: true })).toBeInTheDocument();
    expect(fixture.sendCalls()).toEqual([]);
  } finally {
    cleanup(); fixture.restore();
    if (previousViewport) Object.defineProperty(window, 'visualViewport', previousViewport);
  }
});
