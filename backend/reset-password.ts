#!/usr/bin/env tsx
import { getUserByUsername } from './src/auth/user-store.js';
import { hashPassword } from './src/auth/auth-service.js';
import { getDatabase } from './src/database/db.js';

async function resetPassword() {
  const username = 'conor';
  const newPassword = process.argv[2];

  if (!newPassword) {
    console.error('Usage: npx tsx reset-password.ts <new-password>');
    process.exit(1);
  }

  console.log(`Resetting password for user: ${username}`);

  // Initialize database first
  const db = getDatabase();

  const user = getUserByUsername(username);
  if (!user) {
    console.error(`User "${username}" not found`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(newPassword);

  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?')
    .run(passwordHash, new Date().toISOString(), username);

  console.log(`✓ Password reset successfully for "${username}"`);
  console.log(`  New password: ${newPassword}`);
  console.log(`  User ID: ${user.id}`);
}

resetPassword();
