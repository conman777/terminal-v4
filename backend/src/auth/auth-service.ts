import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID, createHash } from 'crypto';
import {
  createUser,
  getUserByUsername,
  getUserById,
  toPublicUser,
  createRefreshToken,
  getRefreshTokenByHash,
  deleteRefreshToken,
  deleteUserRefreshTokens,
  deleteExpiredRefreshTokens,
  User,
  UserPublic
} from './user-store.js';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

// Get secrets from environment or use defaults for development
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'dev-refresh-secret-change-in-production';

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

// Hash a password
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Verify a password against a hash
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Generate a JWT access token
function generateAccessToken(user: User): string {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

// Generate a refresh token and store it
function generateRefreshToken(userId: string): string {
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

// Register a new user
export async function register(username: string, password: string): Promise<AuthResult> {
  // Check if username already exists
  const existing = getUserByUsername(username);
  if (existing) {
    throw new Error('Username already exists');
  }

  // Create user
  const passwordHash = await hashPassword(password);
  const user = createUser(username, passwordHash);

  // Generate tokens
  const tokens: TokenPair = {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user.id)
  };

  return {
    user: toPublicUser(user),
    tokens
  };
}

// Login with username and password
export async function login(username: string, password: string): Promise<AuthResult> {
  const user = getUserByUsername(username);
  if (!user) {
    throw new Error('Invalid credentials');
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  // Generate tokens
  const tokens: TokenPair = {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user.id)
  };

  return {
    user: toPublicUser(user),
    tokens
  };
}

// Refresh tokens
export function refreshTokens(refreshToken: string): TokenPair {
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

  // Get user
  const user = getUserById(storedToken.user_id);
  if (!user) {
    deleteRefreshToken(storedToken.id);
    throw new Error('User not found');
  }

  // Delete old refresh token (rotation)
  deleteRefreshToken(storedToken.id);

  // Generate new tokens
  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user.id)
  };
}

// Logout - invalidate all refresh tokens for user
export function logout(userId: string): void {
  deleteUserRefreshTokens(userId);
}
