import { lazy, Suspense, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MountOnFirstOpen } from './MountOnFirstOpen';

describe('MountOnFirstOpen', () => {
  it('defers the import until opening and preserves draft state after closing', async () => {
    function Dialog({ isOpen }) {
      const [draft, setDraft] = useState('');
      return isOpen ? <input aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} /> : null;
    }
    const load = vi.fn(async () => ({ default: Dialog }));
    const LazyDialog = lazy(load);
    const view = isOpen => <Suspense fallback={null}><MountOnFirstOpen isOpen={isOpen}><LazyDialog isOpen={isOpen} /></MountOnFirstOpen></Suspense>;
    const { rerender } = render(view(false));
    expect(load).not.toHaveBeenCalled();
    rerender(view(true));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Draft' }), { target: { value: 'Retained draft' } });
    rerender(view(false));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    rerender(view(true));
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Retained draft');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
