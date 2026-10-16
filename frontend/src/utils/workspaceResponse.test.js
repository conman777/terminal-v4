import { describe, expect, it } from 'vitest';
import { latestWorkspaceResponse } from './workspaceResponse';

describe('latestWorkspaceResponse', () => {
  it('returns the latest completed assistant turn and never an earlier response after a newer user prompt', () => {
    const completed = [{ role: 'user', content: 'Request' }, { role: 'assistant', content: 'Answer', streaming: false }];
    expect(latestWorkspaceResponse(completed)).toBe('Answer');
    expect(latestWorkspaceResponse([...completed, { role: 'tool', content: 'Tool output' }])).toBe('');
    expect(latestWorkspaceResponse([...completed, { role: 'user', content: 'New request' }])).toBe('');
    expect(latestWorkspaceResponse([{ role: 'assistant', content: 'Partial', streaming: true }])).toBe('');
    expect(latestWorkspaceResponse(completed, true)).toBe('');
  });
});
