import { getAiComposerSlashCommands } from './aiProviders';

export function getComposerSlashCommands(providerId, customProviders = []) {
  if (typeof providerId !== 'string') return [];
  return getAiComposerSlashCommands(providerId, customProviders);
}

// Installed skills run by name: the agent is told to follow that skill's instructions file.
export function skillSlashCommands(skills = []) {
  return skills.filter(skill => skill?.name && skill?.path).map(skill => ({
    cmd: `/${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    desc: `Skill · ${skill.provider || 'local'}`,
    insert: `Use the "${skill.name}" skill (instructions: ${skill.path}). `,
  })).filter(command => command.cmd.length > 1);
}

export function getComposerSlashSuggestions(input, providerId, customProviders = [], skills = []) {
  if (typeof input !== 'string') return [];

  const query = input.trim().toLowerCase();
  if (!query.startsWith('/')) return [];

  return [...getComposerSlashCommands(providerId, customProviders), ...skillSlashCommands(skills)]
    .filter((command) => command.cmd.startsWith(query));
}
