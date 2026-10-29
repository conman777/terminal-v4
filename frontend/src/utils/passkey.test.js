import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { apiFetch } from './api';
import { registerPasskey, authenticateWithPasskey, deletePasskey } from './passkey';

vi.mock('@simplewebauthn/browser', () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock('./api', () => ({ apiFetch: vi.fn() }));
vi.mock('./apiBase', () => ({ resolveApiUrl: (url) => url }));

const options = { challenge: 'synthetic-challenge', rpId: 'localhost' };
const credential = { id: 'synthetic-credential' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  startRegistration.mockResolvedValue(credential);
  startAuthentication.mockResolvedValue(credential);
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('registerPasskey', () => {
  it('unwraps the Rust WebAuthn creation response before starting registration', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ publicKey: options })).mockResolvedValueOnce(Response.json({ id: credential.id }));
    await expect(registerPasskey('Laptop')).resolves.toEqual({ id: credential.id });
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ credential, name: 'Laptop' });
  });
});

describe('authenticateWithPasskey', () => {
  it('unwraps the Rust WebAuthn request response and submits the resulting assertion', async () => {
    const auth = { user: { id: 'synthetic-user' }, tokens: { accessToken: 'synthetic-token' } };
    fetch.mockResolvedValueOnce(Response.json({ publicKey: options })).mockResolvedValueOnce(Response.json(auth));
    await expect(authenticateWithPasskey('synthetic-user')).resolves.toEqual(auth);
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ username: 'synthetic-user', credential });
  });
});

describe('deletePasskey', () => {
  it('accepts the API empty 204 deletion response', async () => {
    apiFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deletePasskey('synthetic-key')).resolves.toBeUndefined();
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/passkey/credentials/synthetic-key', { method: 'DELETE' });
  });
  it('preserves API deletion errors', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ error: 'Credential not found' }, { status: 404 }));
    await expect(deletePasskey('missing')).rejects.toThrow('Credential not found');
  });
});
