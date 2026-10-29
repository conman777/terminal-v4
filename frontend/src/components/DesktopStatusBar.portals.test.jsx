import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopStatusBar } from './DesktopStatusBar';
import { FollowupQueueButton } from './FollowupQueueButton';
import { ConversationContextButton } from './ConversationContextButton';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { apiFetch } from '../utils/api';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn(), uploadScreenshot: vi.fn() }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect: vi.fn() }) }));
vi.mock('../utils/autocorrect', () => ({ getSpellChecker: async () => ({ correct: () => true }), getAutocorrectSuggestion: () => null }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));

const SESSION = 'ss-portal-submit';
const MAIN = 'Keep the ordinary draft out of portal submissions.';
const ITEM = '00000000-0000-4000-8000-000000000001';
const INPUT = '00000000-0000-4000-8000-000000000002';
const TURN = '00000000-0000-4000-8000-000000000003';
const controls = { sessionId: SESSION, generation: 1, latestSeq: 0, events: [], truncated: false };
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
let queue;
function Composer({ onSubmit }) {
  const [value, setValue] = useState(MAIN);
  return <DesktopStatusBar sessionId={SESSION} composerValue={value} composerAttachments={[]} onComposerChange={setValue}
    onComposerSubmit={text => { onSubmit(text); setValue(''); }} customAiProviders={[]} connectionState="online"
    composerSecondaryAction={<><FollowupQueueButton sessionId={SESSION} /><ConversationContextButton sessionId={SESSION} controlState={controls} /></>} />;
}
function context() {
  return { schemaVersion: 1, sessionId: SESSION, asOfSeq: 0, measuredAt: '2026-10-17T00:00:00Z', provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: 'high',
    conversationRevision: 'a'.repeat(64), scope: 'saved_conversation', measurementScope: 'saved_text_and_metadata', draftIncluded: false, hydratedBinaryIncluded: false,
    sampleStatus: 'current', canCompact: true, blockedReason: null,
    usage: { provider: 'deepseek', model: 'deepseek-v4-pro', measurementScope: 'saved_text_and_metadata', requestBytes: 1000, byteLimit: 600000, autoTriggerBytes: 420000, safeRequestBytes: 520000,
      knownContextWindow: null, reservedOutputTokens: null, lastRequest: null, warning: null } };
}

describe('DesktopStatusBar with real portal forms', () => {
  beforeEach(() => {
    setEnvironmentIdentity('portal-fixture-' + crypto.randomUUID(), window.location.origin);
    setActiveEnvironment(null);
    queue = { revision: 0, mode: 'held', holdReason: 'manual', items: [], order: [] };
    apiFetch.mockReset().mockImplementation(async (url, options) => {
      if (url === `/api/structured/sessions/${SESSION}/context`) return json(context());
      if (url === `/api/structured/sessions/${SESSION}/compact`) return json({ status: 'accepted', requestId: options.body.requestId, turnId: TURN, acceptedSeq: 1 });
      if (url === `/api/structured/sessions/${SESSION}/queue` && options?.method !== 'POST') return json(queue);
      if (url === `/api/structured/sessions/${SESSION}/queue` && options?.method === 'POST') {
        const { operationId, operation } = options.body;
        queue.revision += 1;
        if (operation.kind === 'enqueue') { queue.items = [{ itemId: operation.itemId, revision: 1, inputRequestId: INPUT, text: operation.text, state: 'pending' }]; queue.order = [operation.itemId]; }
        else if (operation.kind === 'edit') queue.items = queue.items.map(item => ({ ...item, revision: item.revision + 1, text: operation.text }));
        else throw new Error('Unexpected queue fixture operation');
        return json({ operationId, queueRevision: queue.revision, itemId: operation.itemId, itemRevision: queue.items[0].revision });
      }
      throw new Error('Unexpected portal fixture route: ' + url);
    });
  });
  it('enqueues through the real Queue portal without submitting or clearing the ordinary composer', async () => {
    const onSubmit = vi.fn();render(<Composer onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open follow-up queue' }));
    fireEvent.change(await screen.findByLabelText('Queued message', { exact: true }), { target: { value: 'Portal queued message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message', exact: true }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/structured/sessions/${SESSION}/queue`, expect.objectContaining({ method: 'POST', body: expect.objectContaining({ operation: expect.objectContaining({ kind: 'enqueue', text: 'Portal queued message' }) }) })));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(MAIN);
  });
  it('edits through the real Queue portal without submitting or clearing the ordinary composer', async () => {
    queue = { revision: 1, mode: 'held', holdReason: 'manual', items: [{ itemId: ITEM, revision: 1, inputRequestId: INPUT, text: 'Original queue item', state: 'pending' }], order: [ITEM] };
    const onSubmit = vi.fn();render(<Composer onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open follow-up queue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit message 1' }));
    fireEvent.change(screen.getByLabelText('Edit queued message'), { target: { value: 'Edited queue item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save queued edit' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/structured/sessions/${SESSION}/queue`, expect.objectContaining({ method: 'POST', body: expect.objectContaining({ operation: expect.objectContaining({ kind: 'edit', text: 'Edited queue item' }) }) })));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(MAIN);
  });
  it('compacts through the real Context portal without submitting or clearing the ordinary composer', async () => {
    const onSubmit = vi.fn();render(<Composer onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation context' }));
    const compact = await screen.findByRole('button', { name: 'Compact conversation', exact: true });
    await waitFor(() => expect(compact).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Compaction instructions (optional)'), { target: { value: 'Only compact these separate instructions' } });
    fireEvent.click(compact);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/structured/sessions/${SESSION}/compact`, expect.objectContaining({ method: 'POST', body: expect.objectContaining({ instructions: 'Only compact these separate instructions' }) })));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(MAIN);
  });
  it('still submits the ordinary form once through its Send control', () => {
    const onSubmit = vi.fn();render(<Composer onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send to terminal' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(MAIN);
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue('');
  });
  it('still submits the live ordinary textarea value on Enter when controlled state is behind', () => {
    const onSubmit = vi.fn();render(<Composer onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox', { name: 'Command composer' });
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'New ordinary live text');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('New ordinary live text');
  });
});
