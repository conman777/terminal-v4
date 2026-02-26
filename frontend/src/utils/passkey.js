import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { apiFetch } from './api';

const API_BASE = import.meta.env.VITE_API_URL || '';

async function publicPost(url, body) {
  const response = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

export async function registerPasskey(name) {
  // Begin registration (requires JWT - uses apiFetch for auth)
  const beginResponse = await apiFetch('/api/auth/passkey/register/begin', { method: 'POST' });
  if (!beginResponse.ok) {
    const err = await beginResponse.json().catch(() => ({ error: 'Failed to begin registration' }));
    throw new Error(err.error || 'Failed to begin registration');
  }
  const options = await beginResponse.json();

  // Trigger the browser's passkey UI (must be called from a user gesture)
  const credential = await startRegistration({ optionsJSON: options });

  // Complete registration
  const completeResponse = await apiFetch('/api/auth/passkey/register/complete', {
    method: 'POST',
    body: JSON.stringify({ credential, name }),
    headers: { 'Content-Type': 'application/json' }
  });
  if (!completeResponse.ok) {
    const err = await completeResponse.json().catch(() => ({ error: 'Registration failed' }));
    throw new Error(err.error || 'Registration failed');
  }
  return completeResponse.json();
}

export async function authenticateWithPasskey(username) {
  // Begin authentication (public endpoint)
  const options = await publicPost('/api/auth/passkey/authenticate/begin', { username });

  // Trigger Face ID / passkey prompt (must be called from a user gesture)
  const credential = await startAuthentication({ optionsJSON: options });

  // Complete authentication - returns AuthResult { user, tokens }
  return publicPost('/api/auth/passkey/authenticate/complete', { username, credential });
}

export async function listPasskeys() {
  const response = await apiFetch('/api/auth/passkey/credentials');
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Failed to load passkeys' }));
    throw new Error(err.error || 'Failed to load passkeys');
  }
  const data = await response.json();
  return data.credentials || [];
}

export async function deletePasskey(id) {
  const response = await apiFetch(`/api/auth/passkey/credentials/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Failed to delete passkey' }));
    throw new Error(err.error || 'Failed to delete passkey');
  }
  return response.json();
}
