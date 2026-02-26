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
const ACCESS_TOKEN_EXPIRY = '24h';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

const DEV_JWT_SECRET = 'dev-jwt-secret-change-in-production';
const DEV_REFRESH_SECRET = 'dev-refresh-secret-change-in-production';

// Get secrets from environment or use defaults for development
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET;
const REFRESH_SECRET = process.env.REFRESH_SECRET || DEV_REFRESH_SECRET;
const ALLOWED_USERNAME = process.env.ALLOWED_USERNAME?.trim();
const REQUIRE_STRONG_SECRETS = process.env.NODE_ENV === 'production';

export function assertAuthConfig(): void {
  if (REQUIRE_STRONG_SECRETS) {
    if (!process.env.JWT_SECRET || JWT_SECRET === DEV_JWT_SECRET) {
      throw new Error('JWT_SECRET must be set to a strong value in production');
    }
    if (!process.env.REFRESH_SECRET || REFRESH_SECRET === DEV_REFRESH_SECRET) {
      throw new Error('REFRESH_SECRET must be set to a strong value in production');
    }
  }
  if (ALLOWED_USERNAME !== undefined && ALLOWED_USERNAME.length === 0) {
    throw new Error('ALLOWED_USERNAME must not be empty when set');
  }
}

export function isAllowedUsername(username: string): boolean {
  if (!ALLOWED_USERNAME) return true;
  return username === ALLOWED_USERNAME;
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

// Hash a password
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Verify a password against a hash
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Generate a JWT access token
export function generateAccessToken(user: User): string {
  return jwt.sign(
    { sub: user.id, username: user.username },
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

// Register a new user
export async function register(username: string, password: string): Promise<AuthResult> {
  if (!isAllowedUsername(username)) {
    throw new Error('Invalid credentials');
  }
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
  if (!isAllowedUsername(username)) {
    throw new Error('Invalid credentials');
  }
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
export function refreshTokens(refreshToken: string): AuthResult {
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
  if (!isAllowedUsername(user.username)) {
    deleteRefreshToken(storedToken.id);
    throw new Error('User not found');
  }

  // Delete old refresh token (rotation)
  deleteRefreshToken(storedToken.id);

  // Generate new tokens
  const tokens: TokenPair = {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user.id)
  };

  return {
    user: toPublicUser(user),
    tokens
  };
}

// Logout - invalidate all refresh tokens for user
export function logout(userId: string): void {
  deleteUserRefreshTokens(userId);
}
