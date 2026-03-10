import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dropdown } from './Dropdown';

describe('Dropdown', () => {
  it('binds the toggle directly to a button trigger element', () => {
    const triggerClick = vi.fn();

    render(
      <Dropdown
        trigger={(
          <button type="button" onClick={triggerClick} aria-label="Open menu">
            Open
          </button>
        )}
        items={[
          { label: 'First action', onClick: vi.fn() }
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(triggerClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'First action' })).toBeInTheDocument();
  });
});
