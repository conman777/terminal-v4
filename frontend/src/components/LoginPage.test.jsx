import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';

const login = vi.fn();
const loginWithPasskeyResult = vi.fn();
const authenticateWithPasskey = vi.fn();

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    login,
    loginWithPasskeyResult,
    error: null
  })
}));

vi.mock('../utils/passkey', () => ({
  authenticateWithPasskey: (...args) => authenticateWithPasskey(...args)
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits username and password for sign-in', async () => {
    login.mockResolvedValue({ id: 'user-1', username: 'conor' });

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'conor' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('conor', 'secret');
    });
  });

  it('requires a username before starting passkey auth', async () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Passkey' }));

    expect(await screen.findByText('Enter your username first')).toBeInTheDocument();
    expect(authenticateWithPasskey).not.toHaveBeenCalled();
  });
});
