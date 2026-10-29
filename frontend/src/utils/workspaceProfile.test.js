import { describe, expect, it } from 'vitest';
import { buildWorkspaceContext, resolveWorkspaceDefaults } from './workspaceProfile';

describe('buildWorkspaceContext', () => {
  const profile = {
    memory: 'Run cargo test before sharing changes.',
    skills: [
      { id: 'review', name: 'Review', instructions: 'Check error and async boundaries.' },
      { id: 'ship', name: 'Ship', instructions: 'Run the release gates.' },
    ],
  };

  it('loads notes and only explicitly selected skills in profile order', () => {
    expect(buildWorkspaceContext(profile, ['review'], true)).toBe(
      'Workspace knowledge:\nRun cargo test before sharing changes.\n\nSkill: Review\nCheck error and async boundaries.'
    );
  });

  it('can attach a skill without project notes', () => {
    expect(buildWorkspaceContext(profile, ['ship'], false)).toBe('Skill: Ship\nRun the release gates.');
  });

  it('includes selected owned supporting text without loading external files', () => {
    expect(buildWorkspaceContext({ memory: '', skills: [{ id: 'review', name: 'Review', instructions: 'Use references.', supportFiles: { 'references/checklist.md': 'Check async boundaries.' } }] }, ['review'], false)).toBe('Skill: Review\nUse references.\nSupporting file: references/checklist.md\nCheck async boundaries.');
  });

  it('returns no context for an empty workspace or missing skill IDs', () => {
    expect([
      buildWorkspaceContext(null, [], true),
      buildWorkspaceContext({ memory: '', skills: [] }, [], true),
      buildWorkspaceContext(profile, ['missing'], false),
    ]).toEqual(['', '', '']);
  });
});

describe('resolveWorkspaceDefaults', () => {
  const options = [{ id: 'cli' }, { id: 'codex' }, { id: 'claude' }];

  it('returns the project agent, model, and reasoning without a stored launch command', () => {
    expect(resolveWorkspaceDefaults({
      defaultAgent: 'claude',
      selection: { model: 'sonnet', reasoning: 'high', launchCommand: 'do not execute stored commands' },
    }, options)).toEqual({ agentId: 'claude', selection: { model: 'sonnet', reasoning: 'high' } });
  });

  it('inherits the caller default for unsupported or unset project agents', () => {
    expect([
      resolveWorkspaceDefaults(null, options),
      resolveWorkspaceDefaults({ defaultAgent: 'missing' }, options),
      resolveWorkspaceDefaults({ defaultAgent: '' }, options),
    ]).toEqual([null, null, null]);
  });
});
