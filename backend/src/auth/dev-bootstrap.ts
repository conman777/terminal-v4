import { hashPassword } from './auth-service.js';
import { createUser, getUserCount } from './user-store.js';

const DEFAULT_BOOTSTRAP_USERNAME = 'dev';
const DEFAULT_BOOTSTRAP_PASSWORD = 'dev-password';

interface BootstrapLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;

  return fallback;
}

function shouldBootstrap(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'production' && nodeEnv !== 'test';
}

function resolveBootstrapUsername(): string {
  const configuredUsername = process.env.DEV_BOOTSTRAP_USERNAME?.trim();
  if (configuredUsername) return configuredUsername;

  const allowedUsername = process.env.ALLOWED_USERNAME?.trim();
  if (allowedUsername) return allowedUsername;

  return DEFAULT_BOOTSTRAP_USERNAME;
}

function resolveBootstrapPassword(): string {
  const configuredPassword = process.env.DEV_BOOTSTRAP_PASSWORD?.trim();
  if (configuredPassword) return configuredPassword;
  return DEFAULT_BOOTSTRAP_PASSWORD;
}

export async function ensureDevBootstrapUser(logger: BootstrapLogger): Promise<void> {
  if (!shouldBootstrap(process.env.NODE_ENV)) {
    return;
  }

  const enabled = parseBooleanFlag(process.env.DEV_BOOTSTRAP_USER_ENABLED, true);
  if (!enabled) {
    return;
  }

  if (getUserCount() > 0) {
    return;
  }

  const username = resolveBootstrapUsername();
  const password = resolveBootstrapPassword();

  const passwordHash = await hashPassword(password);
  createUser(username, passwordHash);

  logger.info(`[auth] Created development bootstrap user "${username}"`);
  logger.warn(`[auth] Development login credentials -> username: ${username} password: ${password}`);
  logger.warn('[auth] Set DEV_BOOTSTRAP_USER_ENABLED=false to disable bootstrap user creation.');
}
