import { describe, expect, it } from 'vitest';
import { buildProposalRequest, parseWorkspaceProposal } from './workspaceProposals';

const requestId = '00000000-0000-4000-8000-000000000001';
const envelope = {
  type: 'terminal-workspace-proposal', version: 1, requestId,
  title: 'Keep the test command', reason: 'It was verified during this task.',
  operations: [{ kind: 'memoryAppend', content: 'Run cargo test for API changes.' }],
};

describe('parseWorkspaceProposal', () => {
  it('accepts only a complete requested JSON proposal and produces the API shape', () => {
    expect(parseWorkspaceProposal('```json\n' + JSON.stringify(envelope) + '\n```', requestId)).toEqual({
      id: requestId, title: envelope.title, reason: envelope.reason, operations: envelope.operations,
    });
  });
  it.each([
    ['ordinary conversation', 'This looks useful.'],
    ['mixed prose', 'Here it is: ' + JSON.stringify(envelope)],
    ['another request', JSON.stringify({ ...envelope, requestId: '00000000-0000-4000-8000-000000000002' })],
    ['unexpected commands', JSON.stringify({ ...envelope, launchCommand: 'run this' })],
    ['wrong schema', JSON.stringify({ ...envelope, type: 'other' })],
    ['empty operations', JSON.stringify({ ...envelope, operations: [] })],
    ['oversized memory', JSON.stringify({ ...envelope, operations: [{ kind: 'memoryAppend', content: 'x'.repeat(6001) }] })],
    ['unknown operation', JSON.stringify({ ...envelope, operations: [{ kind: 'runCommand', content: 'npm test' }] })],
    ['unverified skill update', JSON.stringify({ ...envelope, operations: [{ kind: 'skillUpdate', id: requestId, name: 'Review', instructions: 'Check errors.' }] })],
  ])('rejects %s', (_label, text) => {
    expect(() => parseWorkspaceProposal(text, requestId)).toThrow();
  });
  it('preserves skill IDs and exact previous text needed for stale-change checks', () => {
    const operations = [{ kind: 'skillUpdate', id: requestId, beforeName: 'Review', beforeInstructions: 'Check errors.', name: 'Review', instructions: 'Check errors and async boundaries.' }];
    expect(parseWorkspaceProposal(JSON.stringify({ ...envelope, operations }), requestId).operations).toEqual(operations);
  });
});

describe('buildProposalRequest', () => {
  it('pins request identity and saved knowledge in a constrained suggestion request', () => {
    const prompt = buildProposalRequest({ memory: 'Use Rust.', skills: [] }, requestId);
    expect(prompt).toContain(requestId);
    expect(prompt).toContain('Use Rust.');
    expect(prompt).toContain('terminal-workspace-proposal');
    expect(prompt).toContain('Do not write');
  });
});

describe('package proposal review', () => {
  const supportFiles = { 'references/review.md': 'Check async boundaries.' };
  it('preserves exact previous and proposed support files for stale checks', () => {
    const operations = [{ kind: 'skillUpdate', id: requestId, beforeName: 'Review', beforeInstructions: 'Check errors.', beforeSupportFiles: { 'references/old.md': 'Old review.' }, name: 'Review', instructions: 'Check errors.', supportFiles }];
    expect(parseWorkspaceProposal(JSON.stringify({ ...envelope, operations }), requestId).operations).toEqual(operations);
  });
  it('accepts packages within the expanded review budget and rejects unsafe support paths', () => {
    const operations = [{ kind: 'skillCreate', skill: { id: requestId, name: 'Review', instructions: 'Use references.', supportFiles: { 'references/large.md': 'x'.repeat(40000) } } }];
    expect(parseWorkspaceProposal(JSON.stringify({ ...envelope, operations }), requestId).operations).toEqual(operations);
    operations[0].skill.supportFiles = { '../outside': 'no' };
    expect(() => parseWorkspaceProposal(JSON.stringify({ ...envelope, operations }), requestId)).toThrow();
  });
  it('isolates account envelope identity from workspace proposals', () => {
    const text = JSON.stringify({ ...envelope, type: 'terminal-account-proposal' });
    expect(parseWorkspaceProposal(text, requestId, 'account').operations).toEqual(envelope.operations);
    expect(() => parseWorkspaceProposal(text, requestId)).toThrow();
    expect(buildProposalRequest({ memory: '', skills: [] }, requestId, 'account')).toContain('terminal-account-proposal');
  });
});


it('reviews complete support-file replacement without losing either version', () => {
  const operations = [{ kind: 'skillUpdate', id: requestId, beforeName: 'Review', beforeInstructions: 'Read references.', beforeSupportFiles: { 'a.md': 'a'.repeat(64000), 'b.md': 'b'.repeat(64000) }, name: 'Review', instructions: 'Read references.', supportFiles: { 'a.md': 'c'.repeat(64000), 'b.md': 'd'.repeat(64000) } }];
  expect(parseWorkspaceProposal(JSON.stringify({ ...envelope, operations }), requestId).operations).toEqual(operations);
});
