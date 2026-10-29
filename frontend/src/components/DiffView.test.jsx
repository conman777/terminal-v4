import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from './DiffView';

const patch = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
beforeEach(() => localStorage.clear());

describe('DiffView', () => {
  it('switches between stacked and side-by-side layouts', () => {
    const view = render(<DiffView patch={patch} file="app.js" />);
    const stacked = view.container.querySelectorAll('tbody tr').length;
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect([stacked, view.container.querySelectorAll('tbody tr').length, view.container.querySelector('.diff-view-split') !== null]).toEqual([4, 3, true]);
  });

  it('turns a comment on a line into a note for the agent', () => {
    const onComment = vi.fn();
    render(<DiffView patch={patch} file="app.js" onComment={onComment} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 2 of app.js' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Name this better' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(onComment.mock.calls).toEqual([['In app.js line 2 (`new`): Name this better']]);
  });
});
