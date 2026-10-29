import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { FollowupQueueButton } from './FollowupQueueButton';
vi.mock('./FollowupQueuePanel', () => ({ FollowupQueuePanel: ({ sessionId, onClose }) => <section><p>{sessionId}</p><button onClick={onClose}>Close queue</button><textarea aria-label="Queue fixture text" /></section> }));
afterEach(() => setActiveEnvironment(null));
it('traps queue dialog focus, closes with Escape, and returns focus to its trigger', () => {
  render(<FollowupQueueButton sessionId="ss-queue-dialog" />);
  const trigger = screen.getByRole('button', { name: 'Open follow-up queue' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Follow-up queue' });
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(screen.getByLabelText('Queue fixture text')).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'Close queue' })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
it('closes an open queue on account or environment scope changes', () => {
  render(<FollowupQueueButton sessionId="ss-queue-scope" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open follow-up queue' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  act(() => setActiveEnvironment({ id: 'queue-synthetic-host', name: 'Fixture', baseUrl: 'https://queue.example.invalid' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
const waiting = { revision: 2, mode: 'running', holdReason: null, items: [], order: ['a', 'b'] };
it('stays hidden for native sessions until the server queue is confirmed available', () => {
  const { rerender } = render(<FollowupQueueButton sessionId="ss-native" required={false} queue={{ status: 'unknown' }} />);
  expect(screen.queryByRole('button', { name: 'Open follow-up queue' })).not.toBeInTheDocument();
  rerender(<FollowupQueueButton sessionId="ss-native" required={false} queue={{ status: 'unavailable', reason: 'none' }} />);
  expect(screen.queryByRole('button', { name: 'Open follow-up queue' })).not.toBeInTheDocument();
  rerender(<FollowupQueueButton sessionId="ss-native" required={false} queue={{ status: 'available', snapshot: waiting }} />);
  expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toHaveTextContent('Queue (2)');
});
it('always shows for V4 conversations even before the probe settles', () => {
  render(<FollowupQueueButton sessionId="ss-v4" queue={{ status: 'unknown' }} />);
  expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toHaveTextContent(/^Queue$/);
});
