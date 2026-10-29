import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationContextPanel } from './ConversationContextPanel';
import { contextSnapshot, historyReceipt } from '../test/compactionFixtures';
const useCompactionControl = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useCompactionControl', () => ({ useCompactionControl }));
let state;
beforeEach(() => {
  state = { context: contextSnapshot(), loading: false, instructions: '', pending: null, outcome: null, error: '', canSubmit: true,
    isSubmitting: false, requiresCleanup: false, setInstructions: vi.fn(), submit: vi.fn(), retry: vi.fn(), reconcile: vi.fn(), reload: vi.fn(), stopConversation: vi.fn() };
  useCompactionControl.mockImplementation(() => state);
});
const mount = props => render(<ConversationContextPanel sessionId="ss-00000000000000000000000000000031" {...props} />);

describe('ConversationContextPanel observable labels and controls', () => {
  it('submits compaction without bubbling a portal submit into its parent composer', () => {
    const submitComposer = vi.fn(event => event.preventDefault());
    render(<form onSubmit={submitComposer}>{createPortal(<ConversationContextPanel sessionId="ss-context-fixture" />, document.body)}</form>);
    fireEvent.click(screen.getByRole('button', { name: 'Compact conversation', exact: true }));
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(submitComposer).not.toHaveBeenCalled();
  });

  it('labels saved text/context bytes without inventing token occupancy or counting images/draft', () => {
    mount(); expect(screen.getByRole('heading', { name: 'Conversation context' })).toBeVisible();
    expect(screen.getByText('Saved text context')).toBeVisible(); expect(screen.getByText('12,345 bytes')).toBeVisible();
    expect(screen.getByText(/metadata.*stored image references/i)).toBeVisible(); expect(screen.getByText(/hydrated.*binary.*unsent draft.*excluded/i)).toBeVisible();
    expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0); expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });
  it('shows actual model/reasoning and separately labels metadata and historical reported usage', () => {
    state.context.usage = { ...state.context.usage, knownContextWindow: 128000, reservedOutputTokens: 8192, lastRequest: { inputTokens: 0, outputTokens: null, cachedInputTokens: 16, cacheCreationTokens: null } };
    mount(); expect(screen.getByText('synthetic-model')).toBeVisible(); expect(screen.getByText(/high/)).toBeVisible();
    expect(screen.getByText(/model context window/i)).toBeVisible(); expect(screen.getByText(/last provider-reported/i)).toBeVisible();
    expect(screen.getByText('0')).toBeVisible(); expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0);
    expect(screen.queryByText(/billing|tokens remaining|tokens used/i)).not.toBeInTheDocument();
  });
  it('keeps optional instructions explicitly separate and submits only a user action', () => {
    mount(); const field = screen.getByLabelText('Compaction instructions (optional)', { exact: true });
    expect(field).toHaveValue(''); fireEvent.change(field, { target: { value: 'Keep decisions' } });
    expect(state.setInstructions).toHaveBeenCalledWith('Keep decisions'); expect(state.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Compact conversation', exact: true })); expect(state.submit).toHaveBeenCalledTimes(1);
  });
  it('shows a queue priority barrier without automatically changing the queue', () => {
    state.context = contextSnapshot({ canCompact: false, blockedReason: 'queue_has_priority' }); state.canSubmit = false; mount();
    expect(screen.getByText(/queue.*priority|queued.*first/i)).toBeVisible(); expect(screen.getByRole('button', { name: 'Compact conversation' })).toBeDisabled();
    expect(state.submit).not.toHaveBeenCalled();
  });
  it('shows unavailable context honestly with no current byte meter', () => {
    state.context = contextSnapshot({ canCompact: false, sampleStatus: 'unavailable', blockedReason: 'unavailable', usage: null, conversationRevision: null, warning: 'Saved target differs from the selected target.' }); state.canSubmit = false;
    mount(); expect(screen.getByText(/Saved target differs/)).toBeVisible(); expect(screen.queryByText('12,345 bytes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compact conversation' })).toBeDisabled();
  });
  it('offers an exact-command retry and result check without automatically doing either', () => {
    state.pending = { body: { requestId: '00000000-0000-4000-8000-000000000031' } }; state.canSubmit = false; mount();
    expect(screen.getByText(/awaiting confirmation|outcome.*unknown/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check compaction outcome' })); expect(state.reconcile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same compaction' })); expect(state.retry).toHaveBeenCalledTimes(1);
  });
  it('shows completion/native-history bytes even when compaction grows saved history', () => {
    state.outcome = { status: 'completed', receipt: historyReceipt() }; mount();
    expect(screen.getByText(/compaction completed/i)).toBeVisible(); expect(screen.getByText(/native history/i)).toBeVisible();
    expect(screen.getByText('30,000 bytes')).toBeVisible(); expect(screen.getByText('31,000 bytes')).toBeVisible();
    expect(screen.queryByText(/saved.*-?1,000|reduced by/i)).not.toBeInTheDocument();
  });
  it('separates cleanup-required state from a committed durable result', () => {
    state.outcome = { status: 'completed', receipt: historyReceipt() }; state.requiresCleanup = true; state.canSubmit = false; mount();
    expect(screen.getByText(/compaction completed/i)).toBeVisible(); expect(screen.getByText(/cleanup.*required|cleanup.*not confirmed/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Compact conversation' })).toBeDisabled();
  });
  it('discloses session-wide Stop and never invokes it on close', () => {
    const close = vi.fn(); mount({ onClose: close, onStopConversation: vi.fn(), conversationBusy: true });
    expect(screen.getByText(/holds queued work/i)).toBeVisible(); expect(screen.getByText(/not.*request-specific|current conversation activity/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop conversation' })); expect(state.stopConversation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close context' })); expect(close).toHaveBeenCalledTimes(1); expect(state.stopConversation).toHaveBeenCalledTimes(1);
  });
  it('keeps the old compact outcome independent of Stop cleanup errors', () => {
    state.outcome = { status: 'completed', receipt: historyReceipt() }; mount({ stopError: 'Stop cleanup could not be confirmed.' });
    expect(screen.getByText(/compaction completed/i)).toBeVisible(); expect(screen.getByText('Stop cleanup could not be confirmed.')).toBeVisible();
  });
});

it('reports a confirmed terminal outcome with missing details without invented before/after counts', () => {
  state.outcome = { status: 'completed', receipt: null, detailsUnavailable: true }; mount();
  expect(screen.getByText(/compaction completed/i)).toBeVisible(); expect(screen.getByText(/details.*not available|details.*unavailable/i)).toBeVisible();
  expect(screen.queryByText('30,000 bytes')).not.toBeInTheDocument();
});

it('offers explicit device-save recovery without resubmitting a compact command', () => {
  state.storeError = 'Compaction work could not be saved on this device.'; state.retrySave = vi.fn(); state.canSubmit = false; mount();
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving on this device' }));
  expect(state.retrySave).toHaveBeenCalledTimes(1); expect(state.submit).not.toHaveBeenCalled();
});

it.each(['busy', 'unavailable'])('uses a neutral model label and precise image-reference/placeholder scope for %s samples', sampleStatus => {
  state.context = contextSnapshot({ sampleStatus, canCompact: false, blockedReason: sampleStatus, usage: null, conversationRevision: null,
    warning: 'The saved target was not sampled. The displayed target is the parent selection.' });
  state.canSubmit = false; mount();
  expect(screen.getByText('Model', { exact: true })).toBeVisible();
  expect(screen.queryByText('Saved model', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText(/stored image references.*text-only.*placeholders/i)).toBeVisible();
  expect(screen.getByText(/hydrated.*binary.*unsent draft.*excluded/i)).toBeVisible();
});
