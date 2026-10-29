import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConsoleTab } from '../ConsoleTab';
import { LogViewer } from './LogViewer';

const makeLogs = (count, offset = 0) => Array.from({ length: count }, (_, index) => ({
  id: offset + index,
  timestamp: 1000 + index,
  level: index % 2 === 0 ? 'log' : 'error',
  message: `Synthetic entry ${offset + index}`,
}));

function setGeometry(viewer, { height = 1000, viewport = 300, top = 120 } = {}) {
  Object.defineProperties(viewer, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => viewport },
  });
  viewer.scrollTop = top;
  fireEvent.scroll(viewer);
}

describe('ConsoleTab shared helper integration', () => {
  it('lets keyboard users reach the named scrollable log region before the REPL', async () => {
    const user = userEvent.setup();
    render(<ConsoleTab logs={makeLogs(2)} previewPort={4173} onEvaluate={() => {}} />);
    screen.getByTitle('Clear console').focus();
    await user.tab();
    expect(screen.getByRole('region', { name: 'Console logs' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'JavaScript expression' })).toHaveFocus();
  });

  it('opens and closes named nested objects and arrays with keyboard controls', async () => {
    const user = userEvent.setup();
    const logs = [{ id: 'json', timestamp: 1000, message: JSON.stringify({ items: [{ value: 'nested value' }] }) }];
    render(<ConsoleTab logs={logs} />);

    const root = screen.getByRole('button', { name: 'Expand object at root', expanded: false });
    root.focus();
    await user.keyboard('{Enter}');
    expect(root).toHaveAttribute('aria-expanded', 'true');

    await user.tab();
    const items = screen.getByRole('button', { name: 'Expand array at root.items', expanded: false });
    expect(items).toHaveFocus();
    await user.keyboard(' ');
    expect(items).toHaveAttribute('aria-expanded', 'true');

    await user.tab();
    const nested = screen.getByRole('button', { name: 'Expand object at root.items[0]', expanded: false });
    expect(nested).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('"nested value"')).toBeVisible();
    await user.keyboard(' ');
    expect(nested).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('"nested value"')).not.toBeInTheDocument();
  });

  it('exposes the selected level and updates it when the filter changes', async () => {
    const user = userEvent.setup();
    render(<ConsoleTab logs={makeLogs(4)} />);
    expect(screen.getByRole('button', { name: /^All/, pressed: true })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Errors/ }));
    expect(screen.getByRole('button', { name: /Errors/, pressed: true })).toBeVisible();
    expect(screen.getByRole('button', { name: /^All/, pressed: false })).toBeVisible();
    expect(screen.queryByText('Synthetic entry 0')).not.toBeInTheDocument();
    expect(screen.getByText('Synthetic entry 1')).toBeVisible();
  });

  it('preserves the older reading position when logs append and offers an explicit jump', async () => {
    const user = userEvent.setup();
    const logs = makeLogs(40);
    const { container, rerender } = render(<ConsoleTab logs={logs} />);
    const viewer = container.querySelector('.log-viewer');
    setGeometry(viewer);
    Object.defineProperty(viewer, 'scrollHeight', { configurable: true, get: () => 1200 });
    rerender(<ConsoleTab logs={[...logs, ...makeLogs(1, 40)]} />);
    expect(viewer.scrollTop).toBe(120);

    await user.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(viewer.scrollTop).toBe(1200);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it.each([0, 20, 32])('follows appended logs within %i pixels of the bottom', (distance) => {
    const logs = makeLogs(40);
    const { container, rerender } = render(<ConsoleTab logs={logs} />);
    const viewer = container.querySelector('.log-viewer');
    setGeometry(viewer, { top: 700 - distance });
    Object.defineProperty(viewer, 'scrollHeight', { configurable: true, get: () => 1200 });
    rerender(<ConsoleTab logs={[...logs, ...makeLogs(1, 40)]} />);
    expect(viewer.scrollTop).toBe(1200);
  });

  it('retains the reading position just outside the bottom threshold', () => {
    const logs = makeLogs(40);
    const { container, rerender } = render(<ConsoleTab logs={logs} />);
    const viewer = container.querySelector('.log-viewer');
    setGeometry(viewer, { top: 667 });
    rerender(<ConsoleTab logs={[...logs, ...makeLogs(1, 40)]} />);
    expect(viewer.scrollTop).toBe(667);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  });

  it('resumes following after the reader scrolls back to the bottom', () => {
    const logs = makeLogs(40);
    const { container, rerender } = render(<ConsoleTab logs={logs} />);
    const viewer = container.querySelector('.log-viewer');
    setGeometry(viewer);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    viewer.scrollTop = 700;
    fireEvent.scroll(viewer);
    rerender(<ConsoleTab logs={[...logs, ...makeLogs(1, 40)]} />);
    expect(viewer.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it.each([120, 700])('handles the actual Preview rolling log cap at scroll position %i', (top) => {
    const logs = makeLogs(200);
    const { container, rerender } = render(<ConsoleTab logs={logs} />);
    const viewer = container.querySelector('.log-viewer');
    setGeometry(viewer, { top });
    rerender(<ConsoleTab logs={[...logs.slice(1), ...makeLogs(1, 200)]} />);
    expect(viewer.scrollTop).toBe(top === 700 ? 1000 : 120);
  });

  it('starts changed level and search results at the top instead of mistaking them for append', () => {
    const { container } = render(<ConsoleTab logs={makeLogs(40)} />);
    const viewer = container.querySelector('.log-viewer');
    setGeometry(viewer);
    fireEvent.click(screen.getByRole('button', { name: /Errors/ }));
    expect(viewer.scrollTop).toBe(0);
    viewer.scrollTop = 120;
    fireEvent.scroll(viewer);
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(viewer.scrollTop).toBe(0);
    viewer.scrollTop = 120;
    fireEvent.scroll(viewer);
    fireEvent.change(screen.getByPlaceholderText('Filter console...'), { target: { value: 'entry 1' } });
    expect(viewer.scrollTop).toBe(0);
  });

  it('keeps following a short list and recovers from empty filter results', () => {
    const logs = makeLogs(1);
    const { container, rerender } = render(<ConsoleTab logs={logs} />);
    const viewer = container.querySelector('.log-viewer');
    setGeometry(viewer, { height: 100, viewport: 300, top: 0 });
    rerender(<ConsoleTab logs={[...logs, ...makeLogs(1, 1)]} />);
    expect(viewer.scrollTop).toBe(100);
    fireEvent.change(screen.getByPlaceholderText('Filter console...'), { target: { value: 'no-match' } });
    expect(screen.getByText('No logs match filters')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Clear search'));
    expect(screen.getByText('Synthetic entry 0')).toBeVisible();
    expect(screen.getByText('Synthetic entry 1')).toBeVisible();
  });

  it('handles an empty viewer without a stale jump action', () => {
    const { container, rerender } = render(<LogViewer logs={makeLogs(40)} renderLog={log => log.message} />);
    setGeometry(container.querySelector('.log-viewer'));
    rerender(<LogViewer logs={[]} renderLog={log => log.message} />);
    expect(screen.getByText('No logs to display')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });
});
