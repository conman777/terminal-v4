import { describe, expect, it } from 'vitest';
import { buildNativeHandoff } from './nativeHandoff';
describe('buildNativeHandoff', () => {
 it('preserves provenance and roles while bounding recent context', () => {
  const result = buildNativeHandoff({ provider: 'claude', sourceId: 'source', workspacePath: '/project', messages: [{ role: 'user', text: 'a'.repeat(14000) }, { role: 'assistant', text: 'Current decision' }] });
  expect(result).toContain('Source: claude / source');
  expect(result).toContain('Context truncated');
  expect(result).toContain('ASSISTANT: Current decision');
  expect(result.length).toBeLessThanOrEqual(12000);
 });
});
