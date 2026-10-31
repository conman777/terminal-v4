import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { apiFetch } from '../utils/api';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { ProjectFilePreview } from './ProjectFilePreview';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));

const props = { sessionId: 'ss-fixture', root: '/work/project', file: { path: 'src/app.js', line: 2 }, onClose: vi.fn() };
const response = body => ({ ok: true, json: async () => body });
function stubClipboard(writeText) {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return () => { if (original) Object.defineProperty(navigator, 'clipboard', original); else delete navigator.clipboard; };
}
const preview = { root: '/work/project', path: 'src/app.js', line: 2, totalLines: 3, lines: [
  { line: 1, text: 'first', truncated: false }, { line: 2, text: 'target', truncated: false }, { line: 3, text: 'last', truncated: false },
] };

beforeEach(() => { localStorage.clear(); setUser({ id: 'file-preview-owner' }); vi.clearAllMocks(); });
afterEach(() => setActiveEnvironment(null));

describe('ProjectFilePreview', () => {
  it('shows an empty file without inventing a line or offering paging', async () => {
    apiFetch.mockResolvedValue(response({ root: '/work/project', path: 'empty.txt', line: 1, totalLines: 0, lines: [] }));
    render(<ProjectFilePreview {...props} file={{ path: 'empty.txt', line: 1 }} />);
    expect(await screen.findByText('This file is empty.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Next lines' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects an empty response for a line beyond the start of the file', async () => {
    apiFetch.mockResolvedValue(response({ root: '/work/project', path: 'empty.txt', line: 2, totalLines: 0, lines: [] }));
    render(<ProjectFilePreview {...props} file={{ path: 'empty.txt', line: 2 }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response');
  });
  it('moves through a long file without skipping lines and restores the earlier page', async () => {
    const lines = Array.from({ length: 35 }, (_, index) => ({ line: index + 1, text: `line ${index + 1}`, truncated: false }));
    apiFetch.mockImplementation(async url => {
      const line = Number(new URL(url, 'http://localhost').searchParams.get('line'));
      return response({ root: props.root, path: props.file.path, line, totalLines: lines.length, lines: lines.slice(Math.max(0, line - 8), Math.min(lines.length, line + 7)) });
    });
    render(<ProjectFilePreview {...props} />);
    expect(await screen.findByText('line 9')).toBeVisible();
    expect(screen.getByText('Lines 1–9 of 35')).toBeVisible();
    expect(screen.getByText('Lines 1–9 of 35')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Previous lines' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Previous lines' }));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const next = screen.getByRole('button', { name: 'Next lines' });
    next.focus(); fireEvent.click(next);
    expect(await screen.findByText('line 24')).toBeVisible();
    expect(screen.getByText('Lines 10–24 of 35')).toBeVisible();
    expect(next).toHaveFocus();
    fireEvent.click(next);
    expect(await screen.findByText('line 35')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next lines' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Previous lines' }));
    expect(await screen.findByText('line 24')).toBeVisible();
    expect(screen.getByText('Lines 10–24 of 35')).toBeVisible();
  });

  it('does not admit another page while a request is pending and ignores it after changing files', async () => {
    const first = { ...preview, totalLines: 20 };
    let finish;
    apiFetch.mockResolvedValueOnce(response(first)).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response({ root: props.root, path: 'other.js', line: 1, totalLines: 1, lines: [{ line: 1, text: 'other file', truncated: false }] }));
    const view = render(<ProjectFilePreview {...props} />);
    await screen.findByText('target');
    const next = screen.getByRole('button', { name: 'Next lines' });
    fireEvent.click(next); fireEvent.click(next);
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(apiFetch).toHaveBeenCalledTimes(2);
    view.rerender(<ProjectFilePreview {...props} file={{ path: 'other.js', line: 1 }} />);
    expect(await screen.findByText('other file')).toBeVisible();
    await act(async () => finish(response({ ...first, line: 11, lines: [{ line: 11, text: 'old page', truncated: false }] })));
    expect(screen.queryByText('old page')).toBeNull();
    expect(screen.getByText('other file')).toBeVisible();
  });

  it('keeps a failed page recoverable and never displays a late page after an account change', async () => {
    const first = { ...preview, totalLines: 20, lines: [{ line: 1, text: 'first', truncated: false }, { line: 2, text: 'target', truncated: false }, { line: 3, text: 'last', truncated: false }] };
    let finish;
    apiFetch.mockResolvedValueOnce(response(first)).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'File changed' }) }).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<ProjectFilePreview {...props} />);
    await screen.findByText('target');
    fireEvent.click(screen.getByRole('button', { name: 'Next lines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('File changed');
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    act(() => setUser({ id: 'other-owner' }));
    await act(async () => finish(response({ ...first, line: 11, lines: [{ line: 11, text: 'late private page', truncated: false }] })));
    expect(screen.queryByText('late private page')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('no longer available');
  });

  it('returns focus to file content after a failed page is retried', async () => {
    const first = { ...preview, totalLines: 20 };
    const next = { ...preview, line: 11, totalLines: 20, lines: [{ line: 10, text: 'line 10', truncated: false }, { line: 11, text: 'line 11', truncated: false }] };
    apiFetch.mockResolvedValueOnce(response(first)).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Temporary problem' }) }).mockResolvedValueOnce(response(next));
    render(<ProjectFilePreview {...props} />);
    await screen.findByText('target');
    fireEvent.click(screen.getByRole('button', { name: 'Next lines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary problem');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('line 11')).toBeVisible();
    expect(screen.getByRole('region', { name: 'File lines' })).toHaveFocus();
  });

  it('can return to the beginning if the file shrank during paging', async () => {
    apiFetch.mockResolvedValueOnce(response({ ...preview, totalLines: 20 }))
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'That line no longer exists' }) })
      .mockResolvedValueOnce(response({ root: props.root, path: props.file.path, line: 1, totalLines: 0, lines: [] }));
    render(<ProjectFilePreview {...props} />);
    await screen.findByText('target');
    fireEvent.click(screen.getByRole('button', { name: 'Next lines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
    fireEvent.click(screen.getByRole('button', { name: 'Go to first line' }));
    expect(await screen.findByText('This file is empty.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'File lines' })).toHaveFocus();
  });
  it('reveals the verified file in its scoped project', async () => {
    const onShowInFiles = vi.fn().mockReturnValue(true);
    apiFetch.mockResolvedValue(response(preview));
    render(<ProjectFilePreview {...props} onShowInFiles={onShowInFiles} />);
    await screen.findByText('target');
    fireEvent.click(screen.getByRole('button', { name: 'Show in Files' }));
    expect(onShowInFiles).toHaveBeenCalledWith({ sessionId: 'ss-fixture', root: '/work/project', file: { path: 'src/app.js', line: 2 } });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the preview open if its thread cannot be confirmed', async () => {
    const onShowInFiles = vi.fn().mockReturnValue(false);
    apiFetch.mockResolvedValue(response(preview));
    render(<ProjectFilePreview {...props} onShowInFiles={onShowInFiles} />);
    await screen.findByText('target');
    fireEvent.click(screen.getByRole('button', { name: 'Show in Files' }));
    expect(screen.getByRole('alert')).toHaveTextContent('thread or workspace changed');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('reads an owned project line and highlights it in a keyboard-dismissable dialog', async () => {
    apiFetch.mockResolvedValue(response(preview));
    render(<ProjectFilePreview {...props} />);
    const dialog = screen.getByRole('dialog', { name: 'File preview: src/app.js, line 2' });
    expect(await screen.findByText('target')).toHaveAttribute('aria-current', 'true');
    const [url, options] = apiFetch.mock.calls[0];
    const params = new URL(url, 'http://localhost').searchParams;
    expect(Object.fromEntries(params)).toEqual({ sessionId: 'ss-fixture', root: '/work/project', path: 'src/app.js', line: '2', query: '' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('copies the full file location with its line number', async () => {
    const copy = vi.fn().mockResolvedValue();
    const restore = stubClipboard(copy);
    try {
      apiFetch.mockResolvedValue(response(preview));
      render(<ProjectFilePreview {...props} />);
      await screen.findByText('target');
      fireEvent.click(screen.getByRole('button', { name: 'Copy file location' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Location copied');
      expect(copy).toHaveBeenCalledWith('/work/project/src/app.js:2');
    } finally { restore(); }
  });

  it('offers selectable text when the clipboard is unavailable', async () => {
    const restore = stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const original = document.execCommand;
    document.execCommand = vi.fn(() => false);
    try {
      apiFetch.mockResolvedValue(response(preview));
      render(<ProjectFilePreview {...props} />);
      await screen.findByText('target');
      fireEvent.click(screen.getByRole('button', { name: 'Copy file location' }));
      expect(await screen.findByRole('textbox', { name: 'File location' })).toHaveValue('/work/project/src/app.js:2');
      expect(screen.getByRole('status')).toHaveTextContent('Could not copy');
    } finally { restore(); document.execCommand = original; }
  });

  it('uses the selection fallback and retains keyboard focus', async () => {
    const restore = stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const original = document.execCommand;
    document.execCommand = vi.fn(() => true);
    try {
      apiFetch.mockResolvedValue(response(preview));
      render(<ProjectFilePreview {...props} />);
      await screen.findByText('target');
      const button = screen.getByRole('button', { name: 'Copy file location' });
      button.focus();
      fireEvent.click(button);
      expect(await screen.findByRole('status')).toHaveTextContent('Location copied');
      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(button).toHaveFocus();
    } finally { restore(); document.execCommand = original; }
  });

  it('discards copy feedback if the account changes while the clipboard is pending', async () => {
    let finish;
    const restore = stubClipboard(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    try {
      apiFetch.mockResolvedValue(response(preview));
      render(<ProjectFilePreview {...props} />);
      await screen.findByText('target');
      fireEvent.click(screen.getByRole('button', { name: 'Copy file location' }));
      act(() => setUser({ id: 'another-owner' }));
      await act(async () => finish());
      expect(screen.queryByText('Location copied')).toBeNull();
    } finally { restore(); }
  });

  it('does not start a second copy while the first is pending', async () => {
    let finish;
    const copy = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const restore = stubClipboard(copy);
    try {
      apiFetch.mockResolvedValue(response(preview));
      render(<ProjectFilePreview {...props} />);
      await screen.findByText('target');
      const button = screen.getByRole('button', { name: 'Copy file location' });
      fireEvent.click(button); fireEvent.click(button);
      expect(copy).toHaveBeenCalledTimes(1);
      await act(async () => finish());
    } finally { restore(); }
  });

  it('rejects a response from a different file or scope', async () => {
    apiFetch.mockResolvedValue(response({ ...preview, path: 'other.js' }));
    render(<ProjectFilePreview {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response');
    expect(screen.queryByText('target')).toBeNull();
  });

  it('does not show the previous file while another reference is loading', async () => {
    apiFetch.mockResolvedValueOnce(response(preview)).mockReturnValueOnce(new Promise(() => {}));
    const view = render(<ProjectFilePreview {...props} />);
    expect(await screen.findByText('target')).toBeVisible();
    view.rerender(<ProjectFilePreview {...props} file={{ path: 'other.js', line: 1 }} />);
    expect(screen.queryByText('target')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Opening file');
  });

  it('discards a late response when the account changes', async () => {
    let finish;
    apiFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<ProjectFilePreview {...props} />);
    act(() => setUser({ id: 'another-owner' }));
    await act(async () => finish(response(preview)));
    expect(screen.queryByText('target')).toBeNull();
  });

  it('discards a late response after switching environments', async () => {
    let finish;
    apiFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<ProjectFilePreview {...props} />);
    act(() => setActiveEnvironment({ id: 'other-host', capabilities: { transfer: true } }));
    await act(async () => finish(response(preview)));
    expect(screen.queryByText('target')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('no longer available');
  });
});
