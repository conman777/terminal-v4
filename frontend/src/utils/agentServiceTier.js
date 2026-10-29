const CODEX_SERVICE_TIERS = ['default', 'fast', 'ultrafast'];

// '' stands for null (follow the local Codex config); the backend's 'default' tier is Standard.
export const CODEX_SPEED_OPTIONS = [
  { value: '', label: 'Default', description: 'Use local Codex settings' },
  { value: 'default', label: 'Standard', description: 'Standard usage' },
  { value: 'fast', label: 'Fast', description: 'Higher usage; availability depends on account' },
  { value: 'ultrafast', label: 'Ultrafast', description: 'Highest usage; eligible plans only' },
];

// An absent serviceTier means an older, unspecified selection and must stay absent.
export function serviceTierEntry(value) {
  if (value === null || CODEX_SERVICE_TIERS.includes(value)) return { serviceTier: value };
  return {};
}
