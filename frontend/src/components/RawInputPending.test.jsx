import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { supervisedInputQueue } from '../utils/supervisedRawInputQueue';
import { setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { RawInputPending } from './RawInputPending';

afterEach(() => vi.useRealTimers());
it('shows unsent input without its contents and lets the user discard it after a failed send', async () => {
  vi.useFakeTimers();
  const queue = supervisedInputQueue('ss-visible-pending', vi.fn().mockRejectedValue(new Error('No input was sent')));
  render(<RawInputPending sessions={[{ id: 'ss-visible-pending', title: 'Fixture thread' }]} />);
  act(() => queue.enqueue('secret'));
  expect(screen.getByRole('status', { name: 'Pending terminal input' })).toHaveTextContent('6 characters waiting');
  expect(screen.getByRole('status', { name: 'Pending terminal input' })).not.toHaveTextContent('secret');
  fireEvent.click(screen.getByRole('button', { name: 'Minimize input status' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show pending input (1)' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(screen.getByText('No input was sent')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Discard waiting input' }));
  expect(screen.queryByRole('status', { name: 'Pending terminal input' })).not.toBeInTheDocument();
});

it('warns that in-flight input may have been delivered when the account changes', async () => {
  vi.useFakeTimers();
  setEnvironmentIdentity('pending-scope', window.location.origin);
  let finish;
  const queue = supervisedInputQueue('ss-scope-visible', () => new Promise(resolve => { finish = resolve; }), 'legacy');
  render(<RawInputPending />);
  act(() => queue.enqueue('private'));
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  act(() => setEnvironmentIdentity('new-scope', window.location.origin));
  expect(screen.getByRole('status', { name: 'Pending terminal input' })).toHaveTextContent('may have been delivered');
  expect(screen.getByRole('status', { name: 'Pending terminal input' })).not.toHaveTextContent('private');
  await act(async () => { finish({ accepted: true }); await vi.advanceTimersByTimeAsync(0); });
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss input notice' }));
  setEnvironmentIdentity(null);
});
