import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import AttachmentDraftStatus from './AttachmentDraftStatus';

it('requires a review before replacing local file selections with the saved selection', async () => {
  const user = userEvent.setup();
  const conflict = { items: [{ name: 'saved.txt', path: '/fixture/saved.txt' }] };
  const useSaved = vi.fn(() => true);
  render(<AttachmentDraftStatus error="Files changed in another tab." conflict={conflict} currentItems={[{ name: 'mine.txt', path: '/fixture/mine.txt' }]} onUseSaved={useSaved} onRetry={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Use saved files' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Review saved files' }));
  expect(screen.getByRole('group', { name: 'Saved file selections' })).toHaveTextContent('saved.txt');
  expect(screen.getByRole('group', { name: 'Saved file selections' })).toHaveTextContent('/fixture/saved.txt');
  expect(screen.getByText(/replace your current file selections/i)).toBeVisible();
  expect(screen.getByText(/Sending remains blocked/)).toBeVisible();
  expect(screen.getByRole('group', { name: 'Saved file selections' })).toHaveTextContent('/fixture/mine.txt');
  await user.click(screen.getByRole('button', { name: 'Use saved files' }));
  expect(useSaved).toHaveBeenCalledExactlyOnceWith(conflict);
});

it('keeps local selections when review is cancelled or the saved selection changes', async () => {
  const user = userEvent.setup();
  const useSaved = vi.fn();
  const first = { items: [{ name: 'one.txt', path: '/one.txt' }] };
  const view = render(<AttachmentDraftStatus error="Files changed." conflict={first} onUseSaved={useSaved} onRetry={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Review saved files' }));
  await user.click(screen.getByRole('button', { name: 'Close review' }));
  expect(screen.getByRole('button', { name: 'Review saved files' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Review saved files' }));
  view.rerender(<AttachmentDraftStatus error="Files changed." conflict={{ items: [{ name: 'two.txt', path: '/two.txt' }] }} onUseSaved={useSaved} onRetry={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Use saved files' })).not.toBeInTheDocument();
  expect(useSaved).not.toHaveBeenCalled();
});

it('explains an empty saved selection and retains ordinary storage retry', async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  const view = render(<AttachmentDraftStatus error="Files changed." conflict={{ items: [] }} onUseSaved={vi.fn()} onRetry={retry} />);
  await user.click(screen.getByRole('button', { name: 'Review saved files' }));
  expect(screen.getByText('The saved selection has no files.')).toBeVisible();
  view.rerender(<AttachmentDraftStatus error="Storage unavailable." conflict={null} onUseSaved={vi.fn()} onRetry={retry} />);
  await user.click(screen.getByRole('button', { name: 'Retry saving files' }));
  expect(retry).toHaveBeenCalledOnce();
});

it('returns focus to review when the saved selection changed before confirmation', async () => {
  const user = userEvent.setup();
  const useSaved = vi.fn(() => false);
  render(<AttachmentDraftStatus error="Files changed." conflict={{ items: [{ name: 'saved.txt', path: '/saved.txt' }] }} onUseSaved={useSaved} onRetry={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Review saved files' }));
  await user.click(screen.getByRole('button', { name: 'Use saved files' }));
  expect(useSaved).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Use saved files' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review saved files' })).toHaveFocus();
});
