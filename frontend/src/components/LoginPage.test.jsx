import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('conor', 'secret');
    });
  });

  it('trims username but preserves whitespace-significant password characters', async () => {
    login.mockResolvedValue({ id: 'user-1', username: 'conor' });

    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '  conor  ' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '  secret  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('conor', '  secret  ');
    });
  });

  it('requires a username before starting passkey auth', async () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Authenticate with Passkey' }));

    expect(await screen.findByText('Enter your username first to use Passkey')).toBeInTheDocument();
    expect(authenticateWithPasskey).not.toHaveBeenCalled();
  });

  describe('test account button', () => {
    const testUsername = 'hermes-test';
    const testPassword = 'local-only-password';
    const buttonName = 'Log in as test user';

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('signs in with the configured test account in one click', async () => {
      vi.stubEnv('VITE_TEST_LOGIN_USERNAME', testUsername);
      vi.stubEnv('VITE_TEST_LOGIN_PASSWORD', testPassword);
      login.mockResolvedValue({ id: 'user-1', username: testUsername });

      render(<LoginPage />);
      fireEvent.click(screen.getByRole('button', { name: buttonName }));

      await waitFor(() => {
        expect(login).toHaveBeenCalledWith(testUsername, testPassword);
      });
    });

    it('is hidden when no test account is configured', () => {
      vi.stubEnv('VITE_TEST_LOGIN_USERNAME', '');
      vi.stubEnv('VITE_TEST_LOGIN_PASSWORD', '');

      render(<LoginPage />);

      expect(screen.queryByRole('button', { name: buttonName })).not.toBeInTheDocument();
    });
  });

  it('announces validation feedback and associates it with the sign-in fields', async () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Username and password are required');
    expect(screen.getByLabelText('Username')).toHaveAccessibleDescription(alert.textContent);
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(alert.textContent);
    expect(login).not.toHaveBeenCalled();
  });
});
