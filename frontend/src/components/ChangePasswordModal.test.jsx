import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChangePasswordModal from './ChangePasswordModal';
import { apiPost } from '../utils/api';

vi.mock('../utils/api', () => ({ apiPost: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe('ChangePasswordModal', () => {
  it('contains focus, dismisses with Escape and restores its opener', () => {
    const onClose = vi.fn();
    const view = render(<><button>Account</button><ChangePasswordModal isOpen={false} onClose={onClose} /></>);
    const opener = screen.getByRole('button', { name: 'Account' });
    opener.focus();
    view.rerender(<><button>Account</button><ChangePasswordModal isOpen onClose={onClose} /></>);
    const dialog = screen.getByRole('dialog', { name: 'Change Password' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(dialog).toHaveFocus();
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<><button>Account</button><ChangePasswordModal isOpen={false} onClose={onClose} /></>);
    expect(opener).toHaveFocus();
  });

  it('announces a password mismatch without submitting a change', () => {
    render(<ChangePasswordModal isOpen onClose={vi.fn()} />);
    for (const [label, value] of [['Current Password', 'synthetic-current'], ['New Password', 'synthetic-new'], ['Confirm New Password', 'synthetic-mismatch']]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match');
    expect(apiPost).not.toHaveBeenCalled();
  });
});
