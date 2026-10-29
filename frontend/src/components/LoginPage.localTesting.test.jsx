import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';

const { login } = vi.hoisted(() => ({ login:vi.fn(async () => ({})) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({login,loginWithPasskeyResult:vi.fn(),error:null}) }));
afterEach(() => { vi.restoreAllMocks(); login.mockClear(); });

describe('username-only local testing access', () => {
  it('asks only for a username and opens its local account without a password', async () => {
    vi.stubGlobal('fetch',vi.fn(async () => ({ok:true,json:async()=>({mode:'local-testing'})})));
    render(<LoginPage />);
    await screen.findByRole('button',{name:'Open workspace'});
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button',{name:'Authenticate with Passkey'})).toBeNull();
    fireEvent.change(screen.getByLabelText('Username'),{target:{value:'  tester  '}});
    fireEvent.click(screen.getByRole('button',{name:'Open workspace'}));
    await waitFor(()=>expect(login).toHaveBeenCalledWith('tester',undefined,'local-testing'));
  });

  it('retains password access when the server does not enable local testing', async () => {
    vi.stubGlobal('fetch',vi.fn(async () => ({ok:true,json:async()=>({mode:'password'})})));
    render(<LoginPage />);
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Authenticate with Passkey'})).toBeInTheDocument();
  });
});
