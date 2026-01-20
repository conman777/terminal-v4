#!/usr/bin/env node

/**
 * Phase 1 Verification Script
 *
 * Quick verification that Phase 1 components are properly structured.
 * This doesn't run the full test suite but validates basic setup.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔍 Phase 1 Verification\n');

const checks = [
  // Storage layer
  { file: 'src/storage/storage-interface.ts', description: 'Storage interface' },
  { file: 'src/storage/sqlite-storage.ts', description: 'SQLite storage adapter' },
  { file: 'src/storage/sqlite-storage.test.ts', description: 'Storage tests' },
  { file: 'src/storage/migration-runner.ts', description: 'Migration runner' },
  { file: 'src/storage/migrations/001-initial-schema.sql', description: 'Initial schema' },

  // Session management
  { file: 'src/browser/session-types.ts', description: 'Session types' },
  { file: 'src/browser/session-pool.ts', description: 'Session pool' },
  { file: 'src/browser/session-manager.ts', description: 'Session manager' },

  // API routes
  { file: 'src/routes/browser-session-routes.ts', description: 'Session API routes' },
];

let passed = 0;
let failed = 0;

for (const check of checks) {
  const filePath = path.join(__dirname, check.file);
  const exists = fs.existsSync(filePath);

  if (exists) {
    const stats = fs.statSync(filePath);
    const size = stats.size;
    console.log(`✅ ${check.description.padEnd(30)} (${(size / 1024).toFixed(1)}KB)`);
    passed++;
  } else {
    console.log(`❌ ${check.description.padEnd(30)} - NOT FOUND`);
    failed++;
  }
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

// Check key code patterns
console.log('🔎 Code Pattern Checks:\n');

const patternChecks = [
  {
    file: 'src/storage/sqlite-storage.ts',
    pattern: /export class SQLiteStorage implements IStorage/,
    description: 'SQLiteStorage implements interface'
  },
  {
    file: 'src/browser/session-manager.ts',
    pattern: /export class SessionManager/,
    description: 'SessionManager class exists'
  },
  {
    file: 'src/routes/browser-session-routes.ts',
    pattern: /app\.post\('\/api\/browser\/sessions'/,
    description: 'POST /api/browser/sessions endpoint'
  },
  {
    file: 'src/index.ts',
    pattern: /registerBrowserSessionRoutes/,
    description: 'Browser session routes registered'
  },
  {
    file: 'src/index.ts',
    pattern: /SQLiteStorage/,
    description: 'SQLite storage initialized'
  }
];

let patternsPassed = 0;
let patternsFailed = 0;

for (const check of patternChecks) {
  const filePath = path.join(__dirname, check.file);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (check.pattern.test(content)) {
      console.log(`✅ ${check.description}`);
      patternsPassed++;
    } else {
      console.log(`❌ ${check.description} - PATTERN NOT FOUND`);
      patternsFailed++;
    }
  } else {
    console.log(`⚠️  ${check.description} - FILE NOT FOUND`);
    patternsFailed++;
  }
}

console.log(`\n📊 Pattern Checks: ${patternsPassed} passed, ${patternsFailed} failed\n`);

// Final summary
const allPassed = failed === 0 && patternsFailed === 0;
if (allPassed) {
  console.log('✅ Phase 1 structure verification: PASSED');
  console.log('📝 See PHASE1_IMPLEMENTATION.md for full verification steps');
  process.exit(0);
} else {
  console.log('❌ Phase 1 structure verification: FAILED');
  console.log(`   ${failed + patternsFailed} issue(s) found`);
  process.exit(1);
}
