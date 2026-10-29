import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '../utils/api';
import { OpenInEditorPicker, preferredEditorKey, resetInstalledEditorsCache } from './OpenInEditorPicker';

vi.mock('../utils/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const editors = [{ id: 'cursor', label: 'Cursor' }, { id: 'vscode', label: 'VS Code' }, { id: 'zed', label: 'Zed' }];

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({ editors });
  vi.mocked(apiPost).mockReset().mockResolvedValue({ opened: true });
  localStorage.clear();
  resetInstalledEditorsCache();
});

describe('OpenInEditorPicker', () => {
  it('lists every installed editor and remembers the chosen one', async () => {
    const { unmount } = render(<OpenInEditorPicker cwd="/w" />);
    const picker = await screen.findByLabelText('Choose editor');
    expect([...picker.options].map(option => option.textContent)).toEqual(['Cursor', 'VS Code', 'Zed']);
    fireEvent.change(picker, { target: { value: 'zed' } });
    unmount();
    render(<OpenInEditorPicker cwd="/w" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Zed' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect([vi.mocked(apiPost).mock.calls, localStorage.getItem(preferredEditorKey())]).toEqual([[['/api/system/open-in-editor', { editor: 'zed', path: '/w' }]], 'zed']);
  });

  it('falls back to the first editor when the remembered one is gone', async () => {
    localStorage.setItem(preferredEditorKey(), 'sublime');
    render(<OpenInEditorPicker cwd="/w" />);
    expect(await screen.findByRole('button', { name: 'Open in Cursor' })).toBeInTheDocument();
  });

  it('opens the chosen editor with Alt+Shift+O', async () => {
    render(<OpenInEditorPicker cwd="/w" />);
    await screen.findByRole('button', { name: 'Open in Cursor' });
    fireEvent.keyDown(window, { code: 'KeyO', altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { code: 'KeyO', metaKey: true, shiftKey: true });
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiPost).mock.calls[0][1]).toEqual({ editor: 'cursor', path: '/w' });
  });

  it('shows no picker for a single editor and reports a failed launch', async () => {
    vi.mocked(apiGet).mockResolvedValue({ editors: [editors[0]] });
    vi.mocked(apiPost).mockRejectedValue(new Error('That editor is not installed on this host'));
    render(<OpenInEditorPicker cwd="/w" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Cursor' }));
    expect([screen.queryByLabelText('Choose editor'), (await screen.findByRole('alert')).textContent]).toEqual([null, 'That editor is not installed on this host']);
  });
});
