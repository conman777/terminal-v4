import { defineConfig } from 'vitest/config';

// Keep the test suite independent from local production-like backend/.env values.
// dotenv/config in src/index.ts will not override values that are already set.
process.env.NODE_ENV = 'test';
process.env.TLS_CERT_FILE = '';
process.env.TLS_KEY_FILE = '';
process.env.ALLOWED_USERNAME = '';
process.env.PREVIEW_SUBDOMAIN_BASES = 'conordart.com,localhost';
process.env.PREVIEW_SUBDOMAIN_BASE = '';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    coverage: {
      enabled: false
    }
  }
});
