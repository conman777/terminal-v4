#!/usr/bin/env node
/**
 * Memory Leak Fixes Verification Script
 *
 * Verifies that all memory leak fixes are properly implemented
 */

const { readFileSync } = require('fs');
const { join } = require('path');

const checks = [
  {
    name: 'Screenshot Service - LRU Cache',
    file: 'backend/src/preview/screenshot-service.ts',
    patterns: [
      /interface ContextEntry/,
      /MAX_CONTEXTS\s*=\s*10/,
      /CONTEXT_TTL\s*=\s*5\s*\*\s*60\s*\*\s*1000/,
      /lastUsed:\s*number/,
      /browserContexts\.delete\(key\)/
    ],
    description: 'Context map has LRU cache with TTL cleanup'
  },
  {
    name: 'Session Pool - Pending Request Cleanup',
    file: 'backend/src/browser/session-pool.ts',
    patterns: [
      /REQUEST_TTL\s*=\s*30000/,
      /requestCleanupInterval/,
      /cleanupStalePendingRequests/,
      /pendingRequests\.delete\(/
    ],
    description: 'Pending requests have TTL-based cleanup'
  },
  {
    name: 'Performance Service - Cached Timestamp',
    file: 'backend/src/browser/performance-service.ts',
    patterns: [
      /latestTimestamp:\s*number/,
      /metrics\.latestTimestamp/,
      /return\s+metrics\.latestTimestamp/
    ],
    description: 'Performance metrics use cached timestamp for O(1) lookup'
  },
  {
    name: 'Performance Service - Efficient Trimming',
    file: 'backend/src/browser/performance-service.ts',
    patterns: [
      /function trimMetrics.*:\s*T\[\]/,
      /array\.slice\(-MAX_METRICS_PER_TYPE\)/,
      /metrics\.coreWebVitals\s*=\s*trimMetrics/
    ],
    description: 'Trimming uses slice instead of splice'
  },
  {
    name: 'PerformanceTab - Size Limiting',
    file: 'frontend/src/components/devtools/PerformanceTab.jsx',
    patterns: [
      /MAX_METRICS\s*=\s*1000/,
      /limitArraySize/,
      /combined\.slice\(-maxSize\)/
    ],
    description: 'Frontend metrics have size limits'
  },
  {
    name: 'Memory Monitor - Created',
    file: 'backend/src/utils/memory-monitor.ts',
    patterns: [
      /MEMORY_CHECK_INTERVAL/,
      /MEMORY_WARNING_THRESHOLD/,
      /startMemoryMonitoring/,
      /stopMemoryMonitoring/,
      /getMemoryStats/
    ],
    description: 'Memory monitoring utility exists'
  },
  {
    name: 'Memory Monitor - Integrated',
    file: 'backend/src/index.ts',
    patterns: [
      /import.*startMemoryMonitoring.*stopMemoryMonitoring/,
      /startMemoryMonitoring\(\)/,
      /stopMemoryMonitoring\(\)/
    ],
    description: 'Memory monitor integrated into server lifecycle'
  }
];

console.log('\n🔍 Verifying Memory Leak Fixes\n');
console.log('='.repeat(80));

let passed = 0;
let failed = 0;

for (const check of checks) {
  const filePath = join(process.cwd(), check.file);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const results = check.patterns.map(pattern => pattern.test(content));
    const allPassed = results.every(r => r);

    if (allPassed) {
      console.log(`\n✅ ${check.name}`);
      console.log(`   ${check.description}`);
      console.log(`   File: ${check.file}`);
      console.log(`   Checks: ${results.length}/${results.length} passed`);
      passed++;
    } else {
      console.log(`\n❌ ${check.name}`);
      console.log(`   ${check.description}`);
      console.log(`   File: ${check.file}`);
      console.log(`   Checks: ${results.filter(r => r).length}/${results.length} passed`);
      console.log(`   Missing patterns:`);
      check.patterns.forEach((pattern, i) => {
        if (!results[i]) {
          console.log(`     - ${pattern}`);
        }
      });
      failed++;
    }
  } catch (error) {
    console.log(`\n❌ ${check.name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

console.log('\n' + '='.repeat(80));
console.log(`\n📊 Summary: ${passed} passed, ${failed} failed\n`);

if (failed === 0) {
  console.log('✨ All memory leak fixes verified!\n');
  process.exit(0);
} else {
  console.log('⚠️  Some checks failed. Please review the implementation.\n');
  process.exit(1);
}
