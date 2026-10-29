import { AgentModelPicker } from './AgentModelPicker';
import { ModelSettingsPopover } from './ModelSettingsPopover';

export function MobileModelSettings({ agentId = 'codex', value, disabled, pending, error, onChange }) {
  const providerLabel = agentId === 'claude' ? 'Claude' : 'Codex';
  return <ModelSettingsPopover value={value} providerLabel={providerLabel} mark={providerLabel[0]} pending={pending} error={error} className="mobile-model-controls" triggerClassName="mobile-model-trigger">
    <AgentModelPicker agentId={agentId} menuControls syncSelection={false} value={value} disabled={disabled} onChange={onChange} />
  </ModelSettingsPopover>;
}
