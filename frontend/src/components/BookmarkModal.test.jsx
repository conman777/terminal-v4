import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookmarkModal } from './BookmarkModal';

afterEach(cleanup);

describe('BookmarkModal editing', () => {
  const bookmarks = [
    { id: 'alpha', name: 'Alpha', command: 'echo alpha', category: 'General' },
    { id: 'beta', name: 'Beta', command: 'echo beta', category: 'Work' },
  ];

  it('loads the newly selected bookmark before updating its target', async () => {
    const onUpdate = vi.fn().mockResolvedValue();
    render(<BookmarkModal isOpen bookmarks={bookmarks} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved alpha' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[1]);
    expect(screen.getByLabelText('Name')).toHaveValue('Beta');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    expect(onUpdate.mock.calls).toEqual([['beta', { name: 'Beta', command: 'echo beta', category: 'Work' }]]);
  });

  it('preserves the bookmark draft and displays a failed save', async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error('Offline'));
    render(<BookmarkModal isOpen bookmarks={bookmarks} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo revised' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    expect(screen.getByLabelText('Command')).toHaveValue('echo revised');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
  });

  it('does not clear a different bookmark editor when an earlier save completes', async () => {
    let finishSave;
    const onUpdate = vi.fn(() => new Promise(resolve => { finishSave = resolve; }));
    render(<BookmarkModal isOpen bookmarks={bookmarks} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[1]);
    await act(async () => finishSave());
    expect(screen.getByLabelText('Name')).toHaveValue('Beta');
    expect(screen.getByLabelText('Command')).toHaveValue('echo beta');
  });

  it('retains a bookmark after a failed deletion and displays the failure', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('Offline'));
    render(<BookmarkModal isOpen bookmarks={bookmarks} onDelete={onDelete} />);
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Delete bookmark' })[0]));
    expect(screen.getByRole('alert')).toHaveTextContent(/could not delete/i);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('keeps a newer draft after saving then reopening the same bookmark', async () => {
    let finish;
    const onUpdate = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    render(<BookmarkModal isOpen bookmarks={bookmarks} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo unsaved newer draft' } });
    expect(screen.getByLabelText('Command')).toHaveValue('echo unsaved newer draft');
    await act(async () => finish());
    expect(screen.getByLabelText('Command')).toHaveValue('echo unsaved newer draft');
  });

  it('keeps a newer add draft when an earlier add request finishes', async () => {
    let finish;
    const onAdd = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    render(<BookmarkModal isOpen bookmarks={bookmarks} onAdd={onAdd} />);
    fireEvent.click(screen.getByTitle('Add bookmark'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Original add' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo original' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    fireEvent.click(screen.getByTitle('Add bookmark'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Newer add draft' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo newer' } });
    await act(async () => finish());
    expect(screen.getByLabelText('Name')).toHaveValue('Newer add draft');
    expect(screen.getByLabelText('Command')).toHaveValue('echo newer');
  });

  it('keeps errors scoped to the failed editor instance', async () => {
    let fail;
    const onUpdate = vi.fn(() => new Promise((resolve, reject) => { fail = reject; }));
    render(<BookmarkModal isOpen bookmarks={bookmarks} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo current draft' } });
    await act(async () => fail(new Error('Earlier request failed')));
    expect(screen.getByLabelText('Command')).toHaveValue('echo current draft');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['add', 'edit'])('retains the active draft when re-clicking the same %s action', kind => {
    render(<BookmarkModal isOpen bookmarks={bookmarks} />);
    const clickCurrent = () => kind === 'add'
      ? fireEvent.click(screen.getByTitle('Add bookmark'))
      : fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    clickCurrent();
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo retain draft' } });
    expect(screen.getByLabelText('Command')).toHaveValue('echo retain draft');
    clickCurrent();
    expect(screen.getByLabelText('Command')).toHaveValue('echo retain draft');
  });

  it('keeps reopened editor draft when a pre-close save completes', async () => {
    let finish;
    const onUpdate = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<BookmarkModal isOpen bookmarks={bookmarks} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })));
    rerender(<BookmarkModal isOpen={false} bookmarks={bookmarks} onUpdate={onUpdate} />);
    rerender(<BookmarkModal isOpen bookmarks={bookmarks} onUpdate={onUpdate} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo reopened draft' } });
    expect(screen.getByLabelText('Command')).toHaveValue('echo reopened draft');
    await act(async () => finish());
    expect(screen.getByLabelText('Command')).toHaveValue('echo reopened draft');
  });
});


describe('BookmarkModal execution', () => {
  it('waits for execution, retains the draft on failure, and closes only after a successful retry', async () => {
    let rejectExecution;
    const onExecute = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectExecution = reject; })).mockResolvedValueOnce();
    const onClose = vi.fn();
    render(<BookmarkModal isOpen bookmarks={[{ id: 'fixture', name: 'Fixture', command: 'echo fixture', category: 'General' }]} onExecute={onExecute} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit bookmark' }));
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Execute bookmark: Fixture' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Execute bookmark: Fixture' })).toBeDisabled();
    await act(async () => rejectExecution(new Error('Input denied (403)')));
    expect(screen.getByRole('alert')).toHaveTextContent('Input denied (403)');
    expect(screen.getByLabelText('Command')).toHaveValue('echo unsaved');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Execute bookmark: Fixture' })));
    expect(onExecute.mock.calls).toEqual([['echo fixture'], ['echo fixture']]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

it('does not close a reopened bookmark editor when an older execution completes', async () => {
  let finishExecution;
  const onExecute = vi.fn(() => new Promise(resolve => { finishExecution = resolve; }));
  const onClose = vi.fn();
  const props = { bookmarks: [{ id: 'fixture', name: 'Fixture', command: 'echo fixture', category: 'General' }], onExecute, onClose };
  const { rerender } = render(<BookmarkModal {...props} isOpen />);
  fireEvent.click(screen.getByRole('button', { name: 'Execute bookmark: Fixture' }));
  rerender(<BookmarkModal {...props} isOpen={false} />);
  rerender(<BookmarkModal {...props} isOpen />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit bookmark' }));
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo new draft' } });
  await act(async () => finishExecution());
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Command')).toHaveValue('echo new draft');
});


describe('BookmarkModal execution draft ownership', () => {
  const bookmarks = [
    { id: 'alpha', name: 'Alpha', command: 'echo saved alpha', category: 'General' },
    { id: 'beta', name: 'Beta', command: 'echo saved beta', category: 'Work' },
  ];

  function Fixture({ onExecute }) {
    const [isOpen, setIsOpen] = useState(true);
    return <BookmarkModal isOpen={isOpen} bookmarks={bookmarks} onExecute={onExecute} onClose={() => setIsOpen(false)} />;
  }

  it('closes after successful execution when no newer editor or draft exists', async () => {
    let finishExecution;
    render(<Fixture onExecute={() => new Promise(resolve => { finishExecution = resolve; })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Execute bookmark: Alpha' }));
    expect(screen.getByRole('heading', { name: 'Bookmarks', exact: true })).toBeVisible();
    await act(async () => finishExecution());
    expect(screen.queryByRole('heading', { name: 'Bookmarks', exact: true })).not.toBeInTheDocument();
  });

  it.each(['add', 'edit', 'reopened edit', 'existing edit'])('preserves a newer %s draft after earlier execution succeeds', async mode => {
    let finishExecution;
    const onExecute = vi.fn(() => new Promise(resolve => { finishExecution = resolve; }));
    render(<Fixture onExecute={onExecute} />);
    if (mode === 'existing edit' || mode === 'reopened edit') {
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Execute bookmark: Alpha' }));
    if (mode === 'reopened edit') {
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[1]);
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    } else if (mode === 'add') {
      fireEvent.click(screen.getByTitle('Add bookmark'));
    } else if (mode === 'edit') {
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit bookmark' })[0]);
    }
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Newer unsaved name' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo newer-unsaved-command' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Newer category' } });
    await act(async () => finishExecution());
    expect(screen.getByRole('heading', { name: 'Bookmarks', exact: true })).toBeVisible();
    expect(['Name', 'Command', 'Category'].map(label => screen.getByLabelText(label).value)).toEqual([
      'Newer unsaved name', 'echo newer-unsaved-command', 'Newer category',
    ]);
    expect(screen.getByRole('button', { name: 'Execute bookmark: Alpha' })).toBeEnabled();
    expect(onExecute.mock.calls).toEqual([['echo saved alpha']]);
  });
});

it('retains separate bookmark and add drafts across editor switches and dismissal', () => {
  const bookmarks=[{id:'alpha',name:'Alpha',command:'echo alpha',category:'General'},{id:'beta',name:'Beta',command:'echo beta',category:'Work'}];
  const props={bookmarks,onClose:vi.fn()};
  const view=render(<BookmarkModal isOpen {...props}/>);
  fireEvent.click(screen.getAllByRole('button',{name:'Edit bookmark'})[0]);
  fireEvent.change(screen.getByLabelText('Command'),{target:{value:'echo unsaved alpha'}});
  fireEvent.click(screen.getByTitle('Add bookmark'));
  fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Unsent add'}});
  fireEvent.change(screen.getByLabelText('Command'),{target:{value:'echo unsaved add'}});
  fireEvent.click(screen.getAllByRole('button',{name:'Edit bookmark'})[1]);
  fireEvent.click(screen.getAllByRole('button',{name:'Edit bookmark'})[0]);
  expect(screen.getByLabelText('Command')).toHaveValue('echo unsaved alpha');
  fireEvent.click(screen.getByTitle('Add bookmark'));
  expect(screen.getByLabelText('Command')).toHaveValue('echo unsaved add');
  view.rerender(<BookmarkModal isOpen={false} {...props}/>);
  view.rerender(<BookmarkModal isOpen {...props}/>);
  expect(screen.getByLabelText('Name')).toHaveValue('Unsent add');
  expect(screen.getByLabelText('Command')).toHaveValue('echo unsaved add');
});

it('keeps keyboard focus usable when a saved form is removed',async()=>{
 const props={bookmarks:[],onAdd:vi.fn(),onClose:vi.fn()};
 const view=render(<BookmarkModal isOpen {...props}/>);
 fireEvent.click(screen.getByTitle('Add bookmark'));
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Fixture'}});
 fireEvent.change(screen.getByLabelText('Command'),{target:{value:'echo fixture'}});
 view.rerender(<BookmarkModal isOpen={false} {...props}/>);
 view.rerender(<BookmarkModal isOpen {...props}/>);
 const add=screen.getByTitle('Add bookmark');
 const save=screen.getByRole('button',{name:'Save'});save.focus();
 await act(async()=>fireEvent.click(save));
 expect(add).toHaveFocus();
});

it('shows bookmark load failure without a confirmed empty count and preserves its form during read retry',()=>{
 const onRetryLoad=vi.fn();const props={isOpen:true,bookmarks:[],onClose:vi.fn(),onAdd:vi.fn(),onRetryLoad,scopeKey:'same-identity'};
 const view=render(<BookmarkModal {...props} loadStatus="error" loadError="Synthetic bookmarks read offline"/>);
 expect(screen.queryByText(/No bookmarks yet/)).not.toBeInTheDocument();
 expect(screen.queryByText('All Bookmarks (0)')).not.toBeInTheDocument();
 expect(screen.getByRole('alert')).toHaveTextContent('Synthetic bookmarks read offline');
 fireEvent.click(screen.getByTitle('Add bookmark'));
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Retain bookmark draft'}});
 fireEvent.change(screen.getByLabelText('Command'),{target:{value:'echo retain'}});
 fireEvent.click(screen.getByRole('button',{name:'Retry loading bookmarks'}));expect(onRetryLoad).toHaveBeenCalledOnce();
 view.rerender(<BookmarkModal {...props} loadStatus="loading" loadError=""/>);
 expect(screen.getByRole('status')).toHaveTextContent('Loading bookmarks');
 view.rerender(<BookmarkModal {...props} loadStatus="ready" loadError=""/>);
 expect(screen.getByLabelText('Name')).toHaveValue('Retain bookmark draft');
 expect(screen.getByLabelText('Command')).toHaveValue('echo retain');
});

it('resets a bookmark draft when the identity scope changes',()=>{
 const props={isOpen:true,bookmarks:[],onClose:vi.fn()};
 const view=render(<BookmarkModal {...props} scopeKey="identity-a"/>);
 fireEvent.click(screen.getByTitle('Add bookmark'));fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Old identity draft'}});
 view.rerender(<BookmarkModal {...props} scopeKey="identity-b" loadStatus="loading"/>);
 expect(screen.queryByRole('textbox',{name:'Name'})).not.toBeInTheDocument();
 expect(screen.queryByText(/No bookmarks yet/)).not.toBeInTheDocument();
});
