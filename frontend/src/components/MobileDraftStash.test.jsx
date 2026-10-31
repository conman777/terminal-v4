import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MobileDraftStash } from './MobileDraftStash';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { loadStash, stashDraft } from '../utils/draftStash';

function Harness({ initial = '' }) {
  const [value, setValue] = useState(initial);
  return <><MobileDraftStash composerValue={value} onComposerChange={setValue} /><output aria-label="draft">{value}</output></>;
}
const draft = () => screen.getByLabelText('draft').textContent;

beforeEach(() => { localStorage.clear(); setEnvironmentIdentity('account-a'); });
afterEach(() => { vi.restoreAllMocks(); setActiveEnvironment(null); setEnvironmentIdentity(''); });

describe('MobileDraftStash', () => {
  it('stashes the draft, clears the composer and lists it for restore', () => {
    render(<Harness initial="Plan the release" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stash this draft' }));
    expect([draft(), loadStash().map(item => item.text)]).toEqual(['', ['Plan the release']]);
    expect(screen.getByRole('button', { name: /Restore draft: Plan the release/ })).toBeInTheDocument();
  });

  it('restores a stashed draft after the current text and removes it from the stash', () => {
    stashDraft('Older idea', 1);
    render(<Harness initial="Now" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stash (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /Restore draft: Older idea/ }));
    expect([draft(), loadStash()]).toEqual(['Now\nOlder idea', []]);
  });

  it('keeps the draft and shows an alert when the save fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    render(<Harness initial="Keep me" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stash' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stash this draft' }));
    expect(draft()).toBe('Keep me');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be stashed');
  });

  it('disables stashing an empty draft and says when nothing is stashed', () => {
    render(<Harness initial="  " />);
    fireEvent.click(screen.getByRole('button', { name: 'Stash' }));
    expect(screen.getByRole('button', { name: 'Stash this draft' })).toBeDisabled();
    expect(screen.getByText('No stashed drafts')).toBeInTheDocument();
  });

  it('reloads the list when the account or environment changes', () => {
    stashDraft('account A draft', 1);
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Stash (1)' })).toBeInTheDocument();
    act(() => { setActiveEnvironment({ id: 'laptop' }); });
    expect(screen.getByRole('button', { name: 'Stash' })).toBeInTheDocument();
    act(() => { setActiveEnvironment(null); });
    expect(screen.getByRole('button', { name: 'Stash (1)' })).toBeInTheDocument();
  });

  it('hides the stash of another account after the identity changes', () => {
    stashDraft('account A draft', 1);
    render(<Harness />);
    act(() => { setEnvironmentIdentity('account-b'); });
    expect(screen.getByRole('button', { name: 'Stash' })).toBeInTheDocument();
  });

  it('closes the list with Escape and returns focus to the Stash button', () => {
    render(<Harness initial="x" />);
    const toggle = screen.getByRole('button', { name: 'Stash' });
    fireEvent.click(toggle);
    screen.getByRole('button', { name: 'Stash this draft' }).focus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Stashed drafts' })).toBeNull();
    expect(toggle).toHaveFocus();
  });
});
