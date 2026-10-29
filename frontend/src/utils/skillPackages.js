import { createUuid } from './createUuid';
export function isSkillId(value) {
  return typeof value === 'string' && value.length === 36 && value.split('-').map(part => part.length).join(',') === '8,4,4,4,12'
    && Array.from(value.replaceAll('-', '')).every(character => /[0-9a-f]/i.test(character));
}

const bytes = value => new TextEncoder().encode(value).length;
const protectedNames = new Set(['auth.json', 'credentials.json', 'terminal.db', 'vault.key', 'id_rsa', 'id_ed25519']);

export function validateSupportFiles(files = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 20) {
    throw new Error('Each package supports at most 20 text files.');
  }
  const paths = Object.keys(files);
  const lowerPaths = new Set();
  let totalBytes = 0;
  for (const [path, content] of Object.entries(files)) {
    const parts = path.toLowerCase().split('/');
    if (!path || bytes(path) > 512 || path.includes('\\') || /[\x00-\x1f\x7f-\x9f:]/.test(path)
      || parts.some(part => !part || part.startsWith('.') || part === 'skill.md' || /\.(mbox|eml|pst|ost)$/.test(part) || protectedNames.has(part))) {
      throw new Error('Support file paths must be safe relative paths without hidden, credential, or email files.');
    }
    if (lowerPaths.has(path.toLowerCase())) throw new Error('Support file paths must be unique without case differences.');
    lowerPaths.add(path.toLowerCase());
    if (paths.some(other => other !== path && other.toLowerCase().startsWith(path.toLowerCase() + '/'))) throw new Error('A support file cannot also be a directory.');
    if (typeof content !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(content)) throw new Error('Support files must contain plain text.');
    const size = bytes(content);
    if (size > 64000) throw new Error('Each support file must be at most 64000 bytes.');
    totalBytes += size;
  }
  if (totalBytes > 128000) throw new Error('Supporting files in one package must total at most 128000 bytes.');
  return files;
}

export function validateSkillPackage(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)
    || Object.keys(skill).some(key => !['id', 'name', 'instructions', 'supportFiles', 'activation'].includes(key))) {
    throw new Error('The skill package contains an unsupported field.');
  }
  if (!isSkillId(skill.id) || typeof skill.name !== 'string' || !skill.name.trim() || Array.from(skill.name).length > 80
    || typeof skill.instructions !== 'string' || !skill.instructions.trim() || Array.from(skill.instructions).length > 6000) {
    throw new Error('Skills require a UUID, a name of up to 80 characters, and instructions of up to 6000 characters.');
  }
  if (skill.activation !== undefined && !['alwaysOn', 'onDemand'].includes(skill.activation)) throw new Error('Choose a valid skill activation.');
  validateSupportFiles(skill.supportFiles);
  return skill;
}

export function parseSkillPackage(text) {
  if (typeof text !== 'string' || bytes(text) > 320000) throw new Error('An imported skill package must be at most 320000 JSON bytes.');
  let skill;
  try { skill = JSON.parse(text); } catch { throw new Error('Paste one complete JSON skill package.'); }
  if (skill && typeof skill === 'object' && !Array.isArray(skill) && !Object.hasOwn(skill, 'id')) skill.id = createUuid();
  return validateSkillPackage(skill);
}

export function validateKnowledgeProfile(profile) {
  if (typeof profile?.memory !== 'string' || Array.from(profile.memory).length > 6000) throw new Error('Knowledge must be at most 6000 characters.');
  if (!Array.isArray(profile.skills) || profile.skills.length > 20) throw new Error('Save at most 20 skill packages.');
  const ids = new Set();
  let supportBytes = 0;
  let contextCharacters = Array.from(profile.memory).length;
  for (const skill of profile.skills) {
    validateSkillPackage(skill);
    if (ids.has(skill.id)) throw new Error('Each skill package must have its own ID.');
    ids.add(skill.id);
    supportBytes += Object.values(skill.supportFiles || {}).reduce((total, content) => total + bytes(content), 0);
    contextCharacters += Array.from(skill.name).length + Array.from(skill.instructions).length;
  }
  if (supportBytes > 256000) throw new Error('Supporting files across the profile must total at most 256000 bytes.');
  if (contextCharacters > 50000) throw new Error('Knowledge, names, and instructions must total at most 50000 characters.');
  return profile;
}
