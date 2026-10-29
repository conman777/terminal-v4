import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ChangePasswordModal from './ChangePasswordModal';

const apiPost = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiPost }));
beforeEach(() => { apiPost.mockReset(); });
afterEach(() => vi.useRealTimers());
function fill() {
  for (const [label, value] of [['Current Password', 'synthetic-current'], ['New Password', 'synthetic-new'], ['Confirm New Password', 'synthetic-new']]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

it('does not let a previous save clear fields or close a reopened password dialog', async () => {
  let finish;
  apiPost.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const options = { isOpen: true, onClose: vi.fn() };
  const view = render(<ChangePasswordModal {...options} />);
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
  expect(screen.getByLabelText('New Password')).toBeDisabled();
  view.rerender(<ChangePasswordModal {...options} isOpen={false} />);
  view.rerender(<ChangePasswordModal {...options} />);
  fill();
  vi.useFakeTimers();
  await act(async () => finish({ success: true }));
  await act(async () => vi.advanceTimersByTime(1600));
  expect(screen.getByLabelText('New Password')).toHaveValue('synthetic-new');
  expect(options.onClose).not.toHaveBeenCalled();
});

it('cancels a completed opening’s delayed close when dismissed before reopening', async () => {
  apiPost.mockResolvedValue({ success: true });
  const options = { isOpen: true, onClose: vi.fn() };
  const view = render(<ChangePasswordModal {...options} />);
  vi.useFakeTimers();
  fill();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Change Password' })));
  view.rerender(<ChangePasswordModal {...options} isOpen={false} />);
  view.rerender(<ChangePasswordModal {...options} />);
  await act(async () => vi.advanceTimersByTime(1600));
  expect(options.onClose).not.toHaveBeenCalled();
});
