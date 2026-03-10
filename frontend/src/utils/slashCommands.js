const PROVIDER_SLASH_COMMANDS = {
  claude: [
    { cmd: '/model', desc: 'Change AI model' },
    { cmd: '/clear', desc: 'Clear conversation' },
    { cmd: '/help', desc: 'Show available commands' },
    { cmd: '/compact', desc: 'Toggle compact mode' },
    { cmd: '/cost', desc: 'Show token usage' },
  ],
  codex: [
    { cmd: '/model', desc: 'Change AI model' },
  ],
};

export function getComposerSlashCommands(providerId) {
  if (typeof providerId !== 'string') return [];
  return PROVIDER_SLASH_COMMANDS[providerId] ?? [];
}

export function getComposerSlashSuggestions(input, providerId) {
  if (typeof input !== 'string') return [];

  const query = input.trim().toLowerCase();
  if (!query.startsWith('/')) return [];

  return getComposerSlashCommands(providerId).filter((command) => command.cmd.startsWith(query));
}
