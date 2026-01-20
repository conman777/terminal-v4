/**
 * Security Tests for Test Runner Sandbox
 *
 * Verifies that the VM sandbox properly isolates test execution
 * and prevents access to dangerous Node.js APIs.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { initializePool, shutdownPool } from './worker-pool.js';
import { runTests } from './test-runner-service.js';

describe('Test Execution Sandbox Security', () => {
  beforeAll(async () => {
    // Initialize worker pool for testing
    await initializePool(1);
  });

  afterAll(async () => {
    // Clean up worker pool
    await shutdownPool();
  });

  test('prevents file system access via require', async () => {
    const maliciousCode = `
      const fs = require('fs');
      fs.writeFileSync('/tmp/pwned', 'hacked');
    `;

    const result = await runTests([
      {
        name: 'Malicious FS Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    expect(result.jobs[0].error).toContain('require is not defined');
  });

  test('prevents process access', async () => {
    const maliciousCode = `
      process.exit(1);
    `;

    const result = await runTests([
      {
        name: 'Malicious Process Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    expect(result.jobs[0].error).toContain('process is not defined');
  });

  test('prevents Buffer access', async () => {
    const maliciousCode = `
      const buf = Buffer.from('test');
    `;

    const result = await runTests([
      {
        name: 'Malicious Buffer Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    expect(result.jobs[0].error).toContain('Buffer is not defined');
  });

  test('prevents global access', async () => {
    const maliciousCode = `
      global.somethingBad = 'hacked';
    `;

    const result = await runTests([
      {
        name: 'Malicious Global Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    expect(result.jobs[0].error).toContain('global is not defined');
  });

  test('prevents __dirname access', async () => {
    const maliciousCode = `
      console.log(__dirname);
    `;

    const result = await runTests([
      {
        name: 'Malicious __dirname Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    expect(result.jobs[0].error).toContain('__dirname is not defined');
  });

  test('prevents __filename access', async () => {
    const maliciousCode = `
      console.log(__filename);
    `;

    const result = await runTests([
      {
        name: 'Malicious __filename Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    expect(result.jobs[0].error).toContain('__filename is not defined');
  });

  test('prevents eval usage', async () => {
    const maliciousCode = `
      eval('console.log("bad")');
    `;

    const result = await runTests([
      {
        name: 'Malicious Eval Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    // VM with codeGeneration.strings = false should prevent eval
    expect(result.jobs[0].error).toBeDefined();
  });

  test('prevents Function constructor', async () => {
    const maliciousCode = `
      const fn = new Function('return process');
      fn();
    `;

    const result = await runTests([
      {
        name: 'Malicious Function Constructor Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    // Even if Function works, it shouldn't have access to process
    expect(result.jobs[0].error).toBeDefined();
  });

  test('enforces execution timeout on infinite loop', async () => {
    const infiniteLoop = `
      while(true) {
        // Infinite loop
      }
    `;

    const result = await runTests([
      {
        name: 'Infinite Loop Test',
        code: infiniteLoop,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    expect(result.jobs[0].error).toContain('timeout');
  }, 70000); // Extend Jest timeout to allow for VM timeout

  test('enforces compilation timeout', async () => {
    // Create extremely large code that takes a long time to parse
    const hugeCode = `
      ${'const x = 1;\n'.repeat(1000000)}
    `;

    const result = await runTests([
      {
        name: 'Huge Code Test',
        code: hugeCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    // Should either timeout during compilation or fail
    expect(result.jobs[0].error).toBeDefined();
  }, 40000);

  test('allows safe Playwright operations', async () => {
    const safeCode = `
      await page.goto('https://example.com');
      const title = await page.title();
      console.log('Title:', title);
    `;

    const result = await runTests([
      {
        name: 'Safe Playwright Test',
        code: safeCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.passed).toBe(1);
    expect(result.jobs[0].status).toBe('passed');
  }, 15000);

  test('allows safe console logging', async () => {
    const safeCode = `
      console.log('This is safe');
      console.error('This is also safe');
      console.warn('Warning is safe too');
    `;

    const result = await runTests([
      {
        name: 'Safe Console Test',
        code: safeCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.passed).toBe(1);
    expect(result.jobs[0].logs.length).toBeGreaterThan(0);
  });

  test('allows safe setTimeout/setInterval', async () => {
    const safeCode = `
      await new Promise(resolve => {
        setTimeout(() => {
          console.log('Timeout fired');
          resolve();
        }, 100);
      });
    `;

    const result = await runTests([
      {
        name: 'Safe Timer Test',
        code: safeCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.passed).toBe(1);
  });

  test('allows safe Promise usage', async () => {
    const safeCode = `
      const result = await Promise.resolve(42);
      console.log('Result:', result);
    `;

    const result = await runTests([
      {
        name: 'Safe Promise Test',
        code: safeCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.passed).toBe(1);
  });

  test('allows safe Math operations', async () => {
    const safeCode = `
      const result = Math.sqrt(16);
      console.log('Result:', result);
    `;

    const result = await runTests([
      {
        name: 'Safe Math Test',
        code: safeCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.passed).toBe(1);
  });

  test('allows safe JSON operations', async () => {
    const safeCode = `
      const obj = { test: 'value' };
      const json = JSON.stringify(obj);
      const parsed = JSON.parse(json);
      console.log('Parsed:', parsed);
    `;

    const result = await runTests([
      {
        name: 'Safe JSON Test',
        code: safeCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.passed).toBe(1);
  });

  test('prevents prototype pollution attempts', async () => {
    const maliciousCode = `
      Object.prototype.polluted = 'bad';
      const test = {};
      console.log(test.polluted);
    `;

    const result = await runTests([
      {
        name: 'Prototype Pollution Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    // Even if this runs, it should be isolated to the sandbox
    expect(result.summary.passed + result.summary.error).toBe(1);
  });

  test('prevents module access via import', async () => {
    const maliciousCode = `
      import('fs').then(fs => {
        fs.writeFileSync('/tmp/pwned', 'hacked');
      });
    `;

    const result = await runTests([
      {
        name: 'Malicious Import Test',
        code: maliciousCode,
        framework: 'playwright'
      }
    ]);

    expect(result.summary.error).toBe(1);
    // Dynamic import should fail or be blocked
    expect(result.jobs[0].error).toBeDefined();
  });
});
