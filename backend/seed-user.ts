#!/usr/bin/env tsx
import { createUser } from './src/auth/user-store.js';
import { hashPassword } from './src/auth/auth-service.js';
import { getDatabase } from './src/database/db.js';

async function seedUser() {
  const username = 'conor';
  const password = process.argv[2] || 'password123'; // Default password

  console.log(`Creating user: ${username}`);
  console.log(`Password: ${password}`);

  // Initialize database first
  getDatabase();

  const passwordHash = await hashPassword(password);

  try {
    const user = createUser(username, passwordHash);
    console.log(`✓ User created successfully!`);
    console.log(`  ID: ${user.id}`);
    console.log(`  Username: ${user.username}`);
    console.log(`  Created: ${user.created_at}`);
  } catch (error: any) {
    if (error.message?.includes('UNIQUE constraint failed')) {
      console.log(`✓ User "${username}" already exists`);
    } else {
      console.error('Error creating user:', error);
      process.exit(1);
    }
  }
}

seedUser();
