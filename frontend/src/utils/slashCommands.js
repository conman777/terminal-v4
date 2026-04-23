import { getAiComposerSlashCommands } from './aiProviders';

export function getComposerSlashCommands(providerId, customProviders = []) {
  if (typeof providerId !== 'string') return [];
  return getAiComposerSlashCommands(providerId, customProviders);
}

export function getComposerSlashSuggestions(input, providerId, customProviders = []) {
  if (typeof input !== 'string') return [];

  const query = input.trim().toLowerCase();
  if (!query.startsWith('/')) return [];

  return getComposerSlashCommands(providerId, customProviders)
    .filter((command) => command.cmd.startsWith(query));
}
