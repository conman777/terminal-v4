import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesModal } from './NotesModal';

const notes = [
  { id: 'alpha', title: 'Alpha', content: 'Original alpha', category: 'General', createdAt: '2026-01-01' },
  { id: 'beta', title: 'Beta', content: 'Original beta', category: 'Work', createdAt: '2026-01-02' },
];
const contentInput = () => screen.getByPlaceholderText('Write something... (Markdown supported)');

describe('NotesModal persistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(overrides = {}) {
    const props = { isOpen: true, onClose: vi.fn(), notes, onAdd: vi.fn(), onUpdate: vi.fn().mockResolvedValue(), onDelete: vi.fn(), ...overrides };
    const result = render(<NotesModal {...props} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Alpha/ })));
    return { ...result, ...props };
  }

  it('names the note dialog, search, and editor fields for keyboard and screen reader users', async () => {
    await setup();
    expect(screen.getByRole('dialog', { name: 'Notes' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search notes' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Alpha');
    expect(screen.getByRole('textbox', { name: 'Note category' })).toHaveValue('General');
    expect(screen.getByRole('textbox', { name: 'Note content' })).toHaveValue('Original alpha');
  });

  it.each(['select', 'back', 'new', 'close', 'escape'])('flushes the pending edit before %s navigation', async (action) => {
    const { onUpdate, onClose } = await setup();
    fireEvent.change(contentInput(), { target: { value: 'Pending alpha edit' } });
    await act(async () => {
      if (action === 'select') fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
      if (action === 'back') fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      if (action === 'new') fireEvent.click(screen.getByTitle('New note (⌘N)'));
      if (action === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      if (action === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onUpdate.mock.calls).toEqual([['alpha', { title: 'Alpha', content: 'Pending alpha edit', category: 'General' }]]);
    if (action === 'select') expect(contentInput()).toHaveValue('Original beta');
    if (action === 'close' || action === 'escape') expect(onClose).toHaveBeenCalledOnce();
  });

  it('retains the editor and error after failed navigation and allows retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue();
    await setup({ onUpdate });
    fireEvent.change(contentInput(), { target: { value: 'Unsaved alpha' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Beta/ })));
    expect(contentInput()).toHaveValue('Unsaved alpha');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows a failed autosave as unsaved and retains its text for retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await setup({ onUpdate: vi.fn().mockRejectedValue(new Error('Offline')) });
    fireEvent.change(contentInput(), { target: { value: 'Autosave draft' } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(contentInput()).toHaveValue('Autosave draft');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('does not automatically resend an unconfirmed save and explains the outcome', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uncertain = Object.assign(new Error('The note save may have completed. Check its status before trying again.'), { outcomeUncertain: true });
    const onUpdate = vi.fn().mockRejectedValueOnce(uncertain).mockResolvedValue();
    await setup({ onUpdate });
    fireEvent.change(contentInput(), { target: { value: 'First draft' } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('alert')).toHaveTextContent(/may have completed/i);
    fireEvent.change(contentInput(), { target: { value: 'More draft' } });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(contentInput()).toHaveValue('More draft');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('saves the latest edit in order when navigation happens during an autosave', async () => {
    let finishFirst;
    const onUpdate = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockResolvedValue();
    await setup({ onUpdate });
    fireEvent.change(contentInput(), { target: { value: 'First edit' } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    fireEvent.change(contentInput(), { target: { value: 'Second edit' } });
    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    await act(async () => finishFirst());
    expect(onUpdate.mock.calls).toEqual([
      ['alpha', { title: 'Alpha', content: 'First edit', category: 'General' }],
      ['alpha', { title: 'Alpha', content: 'Second edit', category: 'General' }],
    ]);
    expect(contentInput()).toHaveValue('Original beta');
  });

  it('flushes an unsaved edit on unmount', async () => {
    const { onUpdate, unmount } = await setup();
    fireEvent.change(contentInput(), { target: { value: 'Last edit' } });
    await act(async () => unmount());
    expect(onUpdate).toHaveBeenCalledWith('alpha', { title: 'Alpha', content: 'Last edit', category: 'General' });
  });

  it('does not close until the pending save has succeeded', async () => {
    let finishSave;
    const onUpdate = vi.fn(() => new Promise(resolve => { finishSave = resolve; }));
    const { onClose } = await setup({ onUpdate });
    fireEvent.change(contentInput(), { target: { value: 'Must persist before closing' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finishSave());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('debounces ordinary edits and leaves the latest saved text visible when reselecting the same note', async () => {
    const { onUpdate } = await setup();
    fireEvent.change(contentInput(), { target: { value: 'Saved alpha' } });
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(onUpdate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(onUpdate).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Alpha/ })));
    expect(contentInput()).toHaveValue('Saved alpha');
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('retains the current note after a failed deletion', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await setup({ onDelete: vi.fn().mockRejectedValue(new Error('Offline')) });
    fireEvent.change(contentInput(), { target: { value: 'Keep this note' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete' })));
    expect(contentInput()).toHaveValue('Keep this note');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not delete/i);
  });

  it('finishes every queued note write before deleting the note', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishFirst;
    let finishSecond;
    const onUpdate = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
    const onDelete = vi.fn().mockResolvedValue();
    await setup({ onUpdate, onDelete });
    fireEvent.change(contentInput(), { target: { value: 'First draft' } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    fireEvent.change(contentInput(), { target: { value: 'Latest draft' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete' })));
    expect(contentInput()).toBeDisabled();
    await act(async () => finishFirst());
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onDelete).not.toHaveBeenCalled();
    await act(async () => finishSecond());
    expect(onDelete.mock.calls).toEqual([['alpha']]);
    expect(screen.getByText('Select a note or create a new one')).toBeInTheDocument();
  });

  it('flushes a pending edit when hidden externally', async () => {
    const { rerender, onUpdate, onClose, onAdd, onDelete } = await setup();
    fireEvent.change(contentInput(), { target: { value: 'Hidden editor change' } });
    await act(async () => rerender(<NotesModal isOpen={false} {...{ notes, onUpdate, onClose, onAdd, onDelete }} />));
    expect(onUpdate).toHaveBeenCalledWith('alpha', { title: 'Alpha', content: 'Hidden editor change', category: 'General' });
  });

  it('keeps a failed new-note draft available for retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onAdd = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue();
    await setup({ onAdd });
    await act(async () => fireEvent.click(screen.getByTitle('New note (⌘N)')));
    fireEvent.change(screen.getByPlaceholderText('Untitled'), { target: { value: 'New draft' } });
    fireEvent.change(contentInput(), { target: { value: 'Keep this text' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(contentInput()).toHaveValue('Keep this text');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(onAdd.mock.calls).toEqual([['New draft', 'Keep this text', 'General'], ['New draft', 'Keep this text', 'General']]);
    expect(screen.getByText('Select a note or create a new one')).toBeInTheDocument();
  });

  it('prevents Escape and repeated New actions from clearing a new draft during submission', async () => {
    let finishSave;
    const onAdd = vi.fn(() => new Promise(resolve => { finishSave = resolve; }));
    await setup({ onAdd });
    await act(async () => fireEvent.click(screen.getByTitle('New note (⌘N)')));
    fireEvent.change(screen.getByPlaceholderText('Untitled'), { target: { value: 'Submitting draft' } });
    await act(async () => fireEvent.click(screen.getByTitle('New note (⌘N)')));
    expect(screen.getByPlaceholderText('Untitled')).toHaveValue('Submitting draft');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByPlaceholderText('Untitled')).toHaveValue('Submitting draft');
    expect(screen.getByPlaceholderText('Untitled')).toBeDisabled();
    await act(async () => finishSave());
    expect(screen.getByText('Select a note or create a new one')).toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledOnce();
  });
});

it('keeps an unsent new note while visiting another note until explicitly cancelled', async () => {
  render(<NotesModal isOpen notes={notes} onClose={vi.fn()} onUpdate={vi.fn()} onAdd={vi.fn()}/>);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'New Note'})));
  fireEvent.change(screen.getByLabelText('Note title'),{target:{value:'Unsent new note'}});
  fireEvent.change(contentInput(),{target:{value:'Retain new note text'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:/Beta/})));
  await act(async()=>fireEvent.click(screen.getByTitle('New note (⌘N)')));
  expect(screen.getByLabelText('Note title')).toHaveValue('Unsent new note');
  expect(contentInput()).toHaveValue('Retain new note text');
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'New Note'})));
  expect(screen.getByLabelText('Note title')).toHaveValue('');
  expect(contentInput()).toHaveValue('');
});

it('does not present a failed or pending note read as an empty collection and preserves a new draft during retry',async()=>{
 const onRetryLoad=vi.fn();const props={isOpen:true,notes:[],onClose:vi.fn(),onAdd:vi.fn(),onUpdate:vi.fn(),onRetryLoad,scopeKey:'same-identity'};
 const view=render(<NotesModal {...props} loadStatus="error" loadError="Synthetic notes read offline"/>);
 expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
 expect(screen.getByRole('alert')).toHaveTextContent('Synthetic notes read offline');
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'New note',exact:true})));
 fireEvent.change(screen.getByLabelText('Note title'),{target:{value:'Retain new draft'}});
 fireEvent.change(screen.getByLabelText('Note content'),{target:{value:'Retain content'}});
 fireEvent.click(screen.getByRole('button',{name:'Retry loading notes'}));expect(onRetryLoad).toHaveBeenCalledOnce();
 view.rerender(<NotesModal {...props} loadStatus="loading" loadError=""/>);
 expect(screen.getByRole('status')).toHaveTextContent('Loading notes');
 expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
 view.rerender(<NotesModal {...props} loadStatus="ready" loadError=""/>);
 expect(screen.getByLabelText('Note title')).toHaveValue('Retain new draft');
 expect(screen.getByLabelText('Note content')).toHaveValue('Retain content');
});

it('resets a note draft on a changed identity scope without clearing it for load retries',async()=>{
 const props={isOpen:true,notes:[],onClose:vi.fn(),onAdd:vi.fn(),onUpdate:vi.fn()};
 const view=render(<NotesModal {...props} scopeKey="identity-a"/>);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'New Note',exact:true})));
 fireEvent.change(screen.getByLabelText('Note title'),{target:{value:'Old identity draft'}});
 view.rerender(<NotesModal {...props} scopeKey="identity-b" loadStatus="loading"/>);
 expect(screen.queryByRole('textbox',{name:'Note title'})).not.toBeInTheDocument();
 expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
});
