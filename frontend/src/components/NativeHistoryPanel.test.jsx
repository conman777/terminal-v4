import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativeHistoryPanel } from './NativeHistoryPanel';
const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
const workspacePath = 'C:/projects/demo';
const row = { sourceId: 'opaque-source', provider: 'codex', title: 'Fix build', messageCount: 2, truncated: false };
const imported = { ...row, workspacePath, messages: [{ role: 'user', text: 'Fix build' }, { role: 'assistant', text: 'Fixed' }] };
const response = (value) => ({ ok: true, json: async () => value });
describe('NativeHistoryPanel', () => {
 beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue(response([])); });
 it('scans on request, imports a snapshot, and inserts only the reviewed editable prompt', async () => {
  const onInsertPrompt = vi.fn();
  render(<NativeHistoryPanel workspacePath={workspacePath} onInsertPrompt={onInsertPrompt} />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  expect(apiFetch.mock.calls[0][0]).toContain('/imports?');
  apiFetch.mockResolvedValueOnce(response({ sources: [row], warnings: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Find native conversations' }));
  await screen.findByText('Fix build');
  apiFetch.mockResolvedValueOnce(response(imported));
  fireEvent.click(screen.getByRole('button', { name: /Import Fix build/ }));
  const editor = await screen.findByLabelText('Review handoff prompt');
  expect(editor.value).toContain('Source: codex');
  expect(editor.value).toContain('USER:');
  expect(onInsertPrompt).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: 'Reviewed context' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add handoff to prompt' }));
  expect(onInsertPrompt).toHaveBeenCalledWith('Reviewed context');
 });
 it('clears a selected import when the workspace changes', async () => {
  apiFetch.mockResolvedValueOnce(response([row]));
  const { rerender } = render(<NativeHistoryPanel workspacePath={workspacePath} onInsertPrompt={vi.fn()} />);
  await screen.findByRole('button', { name: /Open imported Fix build/ });
  apiFetch.mockResolvedValueOnce(response(imported));
  fireEvent.click(screen.getByRole('button', { name: /Open imported Fix build/ }));
  await screen.findByLabelText('Review handoff prompt');
  rerender(<NativeHistoryPanel workspacePath="C:/other" />);
  await waitFor(() => expect(screen.queryByLabelText('Review handoff prompt')).not.toBeInTheDocument());
 });
});

it('distinguishes a completed empty native scan from a scan that has not run', async () => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(response([]));
  render(<NativeHistoryPanel workspacePath={workspacePath} />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('No native conversations found for this workspace.')).not.toBeInTheDocument();
  apiFetch.mockResolvedValueOnce(response({ sources: [], warnings: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Find native conversations' }));
  expect(await screen.findByText('No native conversations found for this workspace.')).toBeInTheDocument();
});

it('retries a failed imported-snapshot list without scanning native conversation files',async()=>{
 apiFetch.mockReset().mockRejectedValueOnce(new Error('Snapshot list offline')).mockResolvedValue(response([row]));
 render(<NativeHistoryPanel workspacePath={workspacePath}/>);
 await screen.findByText('Snapshot list offline');
 fireEvent.click(screen.getByRole('button',{name:'Retry native imports'}));
 expect(await screen.findByRole('button',{name:'Open imported Fix build'})).toBeInTheDocument();
 expect(apiFetch.mock.calls.every(([url])=>url.includes('/imports?'))).toBe(true);
});
