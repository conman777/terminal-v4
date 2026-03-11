import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID, createHash } from 'crypto';
import {
  getUserById,
  createRefreshToken,
  getRefreshTokenByHash,
  deleteRefreshToken,
  deleteUserRefreshTokens,
  deleteExpiredRefreshTokens,
  UserPublic
} from './user-store.js';
import { getNeonUserByEmail, getNeonUserById } from './neon-user-store.js';

const ACCESS_TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

const DEV_JWT_SECRET = 'dev-jwt-secret-change-in-production';

// Get secrets from environment or use defaults for development
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET;
const REQUIRE_STRONG_SECRETS = process.env.NODE_ENV === 'production';

export function assertAuthConfig(): void {
  if (REQUIRE_STRONG_SECRETS) {
    if (!process.env.JWT_SECRET || JWT_SECRET === DEV_JWT_SECRET) {
      throw new Error('JWT_SECRET must be set to a strong value in production');
    }
  }
  if (!process.env.STORAGE_DATABASE_URL) {
    console.warn('STORAGE_DATABASE_URL not set - login will not work');
  }
}

export function isAllowedUsername(username: string): boolean {
  return true;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: UserPublic;
  tokens: TokenPair;
}

export interface JwtPayload {
  sub: string;
  username: string;
  iat: number;
  exp: number;
}

// Verify a password against a hash
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // bcryptjs (used by coin-ai-spy) and bcrypt (used here) produce compatible hashes
  return bcrypt.compare(password, hash);
}

// Generate a JWT access token
export function generateAccessToken(userId: string, email: string): string {
  return jwt.sign(
    { sub: userId, username: email },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

// Generate a refresh token and store it
export function generateRefreshToken(userId: string): string {
  const token = randomUUID();
  const tokenHash = hashToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

  createRefreshToken(userId, tokenHash, expiresAt);
  return token;
}

// Hash a token for storage
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Verify JWT access token
export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

// Login with email and password against Neon Postgres
export async function login(email: string, password: string): Promise<AuthResult> {
  const user = await getNeonUserByEmail(email);
  if (!user) {
    throw new Error('Invalid credentials');
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  // Generate tokens (refresh tokens stored locally in SQLite)
  const tokens: TokenPair = {
    accessToken: generateAccessToken(user.id, user.email),
    refreshToken: generateRefreshToken(user.id)
  };

  return {
    user: {
      id: user.id,
      username: user.email,
      created_at: user.created_at
    },
    tokens
  };
}

// Refresh tokens
export async function refreshTokens(refreshToken: string): Promise<AuthResult> {
  // Clean up expired tokens
  deleteExpiredRefreshTokens();

  const tokenHash = hashToken(refreshToken);
  const storedToken = getRefreshTokenByHash(tokenHash);

  if (!storedToken) {
    throw new Error('Invalid refresh token');
  }

  // Check if token is expired
  if (new Date(storedToken.expires_at) < new Date()) {
    deleteRefreshToken(storedToken.id);
    throw new Error('Refresh token expired');
  }

  // Get user from Neon DB
  const user = await getNeonUserById(storedToken.user_id);
  if (!user) {
    deleteRefreshToken(storedToken.id);
    throw new Error('User not found');
  }

  // Delete old refresh token (rotation)
  deleteRefreshToken(storedToken.id);

  // Generate new tokens
  const tokens: TokenPair = {
    accessToken: generateAccessToken(user.id, user.email),
    refreshToken: generateRefreshToken(user.id)
  };

  return {
    user: {
      id: user.id,
      username: user.email,
      created_at: user.created_at
    },
    tokens
  };
}

// Logout - invalidate all refresh tokens for user
export function logout(userId: string): void {
  deleteUserRefreshTokens(userId);
}
