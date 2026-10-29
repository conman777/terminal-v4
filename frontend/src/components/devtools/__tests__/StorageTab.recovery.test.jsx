import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageTab } from '../StorageTab';

const storage = {
  localStorage: { theme: 'local value' },
  sessionStorage: { theme: 'session value' },
  cookies: {},
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const editTheme = value => {
  const row = screen.getByText('theme').closest('tr');
  fireEvent.click(within(row).getByTitle('Edit'));
  fireEvent.change(within(row).getByRole('textbox'), { target: { value } });
  return row;
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('StorageTab scope and recovery', () => {
  it('prevents add-draft edits while a save is pending', async () => {
    const pending = deferred();
    render(<StorageTab storage={storage} onUpdateStorage={() => pending.promise} />);
    fireEvent.click(screen.getByTitle('Add new item'));
    fireEvent.change(screen.getByPlaceholderText('Key'), { target: { value: 'fixture' } });
    fireEvent.change(screen.getByPlaceholderText('Value'), { target: { value: 'submitted draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    expect(screen.getByPlaceholderText('Key')).toBeDisabled();
    expect(screen.getByPlaceholderText('Value')).toBeDisabled();
    await act(async () => pending.resolve());
  });
  it('does not carry a local-storage edit into a session-storage row with the same key', () => {
    const update = vi.fn();
    render(<StorageTab storage={storage} onUpdateStorage={update} previewPort={4173} />);
    editTheme('local draft');
    fireEvent.click(screen.getByText('Session Storage'));
    expect(screen.queryByTitle('Save')).not.toBeInTheDocument();
    expect(screen.getByText('session value')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a newer edit open when an older save completes after switching stores', async () => {
    const pending = deferred();
    const update = vi.fn(() => pending.promise);
    render(<StorageTab storage={storage} onUpdateStorage={update} previewPort={4173} />);
    const row = editTheme('local draft');
    fireEvent.click(within(row).getByTitle('Save'));
    fireEvent.click(screen.getByText('Session Storage'));
    editTheme('session draft');
    await act(async () => pending.resolve());
    expect(screen.getByDisplayValue('session draft')).toBeInTheDocument();
    expect(update.mock.calls).toEqual([['localStorage', 'set', 'theme', 'local draft']]);
  });

  it('retains the draft, reports save failure and allows a retry without duplicate pending writes', async () => {
    const pending = deferred();
    const update = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    render(<StorageTab storage={storage} onUpdateStorage={update} />);
    const row = editTheme('retry draft');
    fireEvent.click(within(row).getByTitle('Save'));
    fireEvent.keyDown(within(row).getByRole('textbox'), { key: 'Enter' });
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error('Synthetic denied')));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    expect(screen.getByDisplayValue('retry draft')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(screen.queryByTitle('Save')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(update.mock.calls).toEqual(Array(2).fill(['localStorage', 'set', 'theme', 'retry draft']));
  });

  it('abandons an import still reading its file when the preview changes', async () => {
    const pending = deferred();
    const update = vi.fn();
    const view = render(<StorageTab storage={storage} onUpdateStorage={update} previewPort={4173} />);
    const input = screen.getByTitle('Import storage').querySelector('input');
    fireEvent.change(input, { target: { files: [{ size: 100, text: () => pending.promise }] } });
    view.rerender(<StorageTab storage={storage} onUpdateStorage={update} previewPort={5173} />);
    await act(async () => pending.resolve(JSON.stringify({ data: { fixture: 'old target' } })));
    expect(update).not.toHaveBeenCalled();
  });

  it.each([['array', ['value']], ['object value', { fixture: { nested: true } }]])('rejects an import with %s before mutating storage', async (_kind, data) => {
    vi.stubGlobal('alert', vi.fn());
    const update = vi.fn();
    render(<StorageTab storage={storage} onUpdateStorage={update} />);
    const input = screen.getByTitle('Import storage').querySelector('input');
    fireEvent.change(input, { target: { files: [{ size: 100, text: async () => JSON.stringify({ data }) }] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to import');
    expect(update).not.toHaveBeenCalled();
  });
});
