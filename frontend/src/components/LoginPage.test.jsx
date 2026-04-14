import fs from 'node:fs';
import path from 'node:path';
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
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('conor', 'secret');
    });
  });

  it('requires a username before starting passkey auth', async () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Authenticate with Passkey' }));

    expect(await screen.findByText('Enter your username first to use Passkey')).toBeInTheDocument();
    expect(authenticateWithPasskey).not.toHaveBeenCalled();
  });

  it('uses keyboard-safe mobile login styles for iPhone Safari', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/components/LoginPage.css'), 'utf8');

    expect(css).toMatch(/\.pro-login-wrapper\s*\{[\s\S]*min-height:\s*100dvh;[\s\S]*-webkit-overflow-scrolling:\s*touch;/);
    expect(css).toMatch(/\.pro-input\s*\{[\s\S]*font-size:\s*1rem;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*\.pro-login-container\s*\{[\s\S]*margin:\s*0 auto;/);
  });
});
