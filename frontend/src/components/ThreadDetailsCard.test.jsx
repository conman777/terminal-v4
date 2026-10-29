import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThreadDetailsCard } from './ThreadDetailsCard';

describe('ThreadDetailsCard', () => {
  it('shows where the thread runs, its branch and changes, with actions like T3 Code', () => {
    const onOpenFiles = vi.fn();
    const onReviewChanges = vi.fn();
    render(<ThreadDetailsCard machine="This server" cwd="/repo" git={{ available: true, branch: 'fix/ui', added: 41, removed: 13, files: 3 }}
      onOpenFiles={onOpenFiles} onReviewChanges={onReviewChanges} />);
    const card = screen.getByRole('complementary', { name: 'Thread details' });
    expect([card.textContent.includes('This server'), card.textContent.includes('fix/ui'), screen.getByText('+41').textContent, screen.getByText('−13').textContent]).toEqual([true, true, '+41', '−13']);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect([onOpenFiles.mock.calls, onReviewChanges.mock.calls.length]).toEqual([[['/repo']], 1]);
  });

  it('leaves Git rows out for folders without a repository', () => {
    render(<ThreadDetailsCard machine="This server" cwd="/plain" git={{ available: false }} onOpenFiles={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
  });
});
