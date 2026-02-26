import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifyRegistrationResponseOpts,
  type VerifyAuthenticationResponseOpts
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { getUserByUsername, toPublicUser } from './user-store.js';
import type { User } from './user-store.js';
import {
  createPasskeyCredential,
  getPasskeyCredentialByCredentialId,
  getPasskeyCredentialsByUserId,
  updatePasskeyCredentialCounter,
  type PasskeyCredential
} from './passkey-store.js';
import { generateAccessToken, generateRefreshToken } from './auth-service.js';
import type { AuthResult } from './auth-service.js';

const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Terminal';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3020';

// In-memory challenge store with 5-minute TTL
const pendingChallenges = new Map<string, { challenge: string; expiresAt: number }>();

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function storeChallenge(key: string, challenge: string): void {
  // Clean up expired challenges
  const now = Date.now();
  for (const [k, v] of pendingChallenges) {
    if (v.expiresAt < now) pendingChallenges.delete(k);
  }
  pendingChallenges.set(key, { challenge, expiresAt: now + CHALLENGE_TTL_MS });
}

function consumeChallenge(key: string): string | null {
  const entry = pendingChallenges.get(key);
  if (!entry) return null;
  pendingChallenges.delete(key);
  if (entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

export async function beginRegistration(user: User): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existingCredentials = getPasskeyCredentialsByUserId(user.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.username,
    userDisplayName: user.username,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required'
    }
  });

  storeChallenge(`reg:${user.id}`, options.challenge);
  return options;
}

export async function completeRegistration(
  user: User,
  body: RegistrationResponseJSON,
  name?: string
): Promise<PasskeyCredential> {
  const challenge = consumeChallenge(`reg:${user.id}`);
  if (!challenge) {
    throw new Error('Registration challenge not found or expired');
  }

  const verification = await verifyRegistrationResponse({
    response: body,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Registration verification failed');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  return createPasskeyCredential(user.id, {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    transports: credential.transports,
    name
  });
}

export async function beginAuthentication(username: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const user = getUserByUsername(username);
  if (!user) {
    throw new Error('User not found');
  }

  const credentials = getPasskeyCredentialsByUserId(user.id);
  if (credentials.length === 0) {
    throw new Error('No passkeys registered for this user');
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: credentials.map((c) => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined
    }))
  });

  storeChallenge(`auth:${username}`, options.challenge);
  return options;
}

export async function completeAuthentication(username: string, body: AuthenticationResponseJSON): Promise<AuthResult> {
  const challenge = consumeChallenge(`auth:${username}`);
  if (!challenge) {
    throw new Error('Authentication challenge not found or expired');
  }

  const user = getUserByUsername(username);
  if (!user) {
    throw new Error('User not found');
  }

  const storedCredential = getPasskeyCredentialByCredentialId(body.id);
  if (!storedCredential || storedCredential.user_id !== user.id) {
    throw new Error('Credential not found');
  }

  const verification = await verifyAuthenticationResponse({
    response: body,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential: {
      id: storedCredential.credential_id,
      publicKey: new Uint8Array(storedCredential.public_key),
      counter: storedCredential.counter,
      transports: storedCredential.transports ? JSON.parse(storedCredential.transports) : undefined
    }
  });

  if (!verification.verified) {
    throw new Error('Authentication verification failed');
  }

  const { newCounter } = verification.authenticationInfo;
  updatePasskeyCredentialCounter(storedCredential.id, newCounter, new Date().toISOString());

  return {
    user: toPublicUser(user),
    tokens: {
      accessToken: generateAccessToken(user),
      refreshToken: generateRefreshToken(user.id)
    }
  };
}
