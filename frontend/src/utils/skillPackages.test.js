import { describe, expect, it } from 'vitest';
import { parseSkillPackage, validateSkillPackage, validateKnowledgeProfile } from './skillPackages';

const skill = { id: '00000000-0000-4000-8000-000000000003', name: 'Review', instructions: 'Use the checklist.', supportFiles: { 'references/checklist.md': 'Check errors.' } };

describe('V4 skill packages', () => {
  it('imports owned package text with support files and ignores no fields', () => {
    expect(parseSkillPackage(JSON.stringify(skill))).toEqual(skill);
    expect(parseSkillPackage(JSON.stringify({ ...skill, id: undefined })).id).toMatch(/^[\da-f-]{36}$/i);
    expect(() => parseSkillPackage(JSON.stringify({ ...skill, command: 'run' }))).toThrow('unsupported');
  });

  it.each(['../outside.md', '/absolute.md', 'a/../b.md', 'a\\b.md', '.env', 'references/.hidden', 'SKILL.md', 'credentials.json', 'mail/inbox.eml', 'references/SKILL.md', 'vault.key', 'id_ed25519', 'a//b', 'a:b'])('rejects unsafe support path %s', path => {
    expect(() => validateSkillPackage({ ...skill, supportFiles: { [path]: 'text' } })).toThrow();
  });

  it.each([{ 'Readme.md': 'a', 'README.md': 'b' }, { 'references': 'a', 'references/guide.md': 'b' }])('rejects colliding file paths %j', supportFiles => {
    expect(() => validateSkillPackage({ ...skill, supportFiles })).toThrow();
  });

  it('rejects nontext controls while preserving ordinary multiline references', () => {
    expect(() => validateSkillPackage({ ...skill, supportFiles: { 'a.md': 'bad\u0007text' } })).toThrow('plain text');
    expect(validateSkillPackage({ ...skill, supportFiles: { 'a.md': 'line\nnext\r\ntab\tvalue' } }).supportFiles).toEqual({ 'a.md': 'line\nnext\r\ntab\tvalue' });
  });

  it('enforces byte limits and plain text values before submitting a package', () => {
    expect(() => validateSkillPackage({ ...skill, supportFiles: { 'large.txt': 'é'.repeat(33000) } })).toThrow('64000');
    expect(() => validateSkillPackage({ ...skill, supportFiles: { 'one.txt': 3 } })).toThrow('text');
    expect(() => validateKnowledgeProfile({ memory: '', skills: [{ ...skill, supportFiles: { 'a.txt': 'x'.repeat(63000), 'b.txt': 'x'.repeat(63000) } }, { ...skill, id: '00000000-0000-4000-8000-000000000004', supportFiles: { 'a.txt': 'x'.repeat(63000), 'b.txt': 'x'.repeat(63000) } }, { ...skill, id: '00000000-0000-4000-8000-000000000005', supportFiles: { 'extra.md': 'x'.repeat(10000) } }] })).toThrow('256000');
  });
});
