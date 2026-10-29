import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { getAgentReasoningLevels } from '../utils/agentReasoning';
import { savedConnectionBinding, savedConnectionOptions } from '../utils/savedConnectionAgents';
import { CODEX_SPEED_OPTIONS, serviceTierEntry } from '../utils/agentServiceTier';
import { ComposerPicker } from './ComposerPicker';
import { AgentModelMenu } from './AgentModelMenu';
import { ModelSettingsPopover } from './ModelSettingsPopover';
import './AgentModelPicker.css';

function initialReasoning(agent, modelId) {
  const levels = getAgentReasoningLevels(agent, modelId) || [];
  if (agent?.runtime === 'v4') {
    const model = agent.models?.find(candidate => candidate.id === modelId)
      || (!modelId ? agent.models?.find(candidate => candidate.default) || agent.models?.[0] : null);
    if (levels.includes(model?.defaultReasoning)) return model.defaultReasoning;
    return levels.includes('high') ? 'high' : levels[0] || '';
  }
  if (levels.includes('xhigh')) return 'xhigh';
  if (levels.includes('high')) return 'high';
  return levels[0] || '';
}

function selectionFor(agent, model, reasoning, serviceTier) {
  const levels = getAgentReasoningLevels(agent, model.id);
  const isConnection = savedConnectionBinding(agent?.id);
  return {
    model: model.id,
    reasoning: levels !== null && !levels.includes(reasoning) ? initialReasoning(agent, model.id) : reasoning || '',
    ...serviceTierEntry(serviceTier),
    ...(!isConnection && agent?.launchCommand ? { launchCommand: agent.launchCommand } : {}),
    ...(!isConnection && agent?.hostShell ? { hostShell: agent.hostShell } : {}),
    ...(typeof agent?.available === 'boolean' ? { available: agent.available } : {}),
  };
}

function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || typeof value.model !== 'string') return null;
  return {
    model: value.model.trim(),
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
    ...serviceTierEntry(value.serviceTier),
    ...(typeof value.launchCommand === 'string' ? { launchCommand: value.launchCommand } : {}),
    ...(typeof value.hostShell === 'string' ? { hostShell: value.hostShell } : {}),
    ...(typeof value.available === 'boolean' ? { available: value.available } : {}),
  };
}

// syncSelection=false limits onChange to deliberate user choices (no catalog defaults or normalization).
export function AgentModelPicker({ agentId, value, onChange, compact = false, disabled = false, syncSelection = true, menuControls = false, showSpeed = true }) {
  const [catalog, setCatalog] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const rootRef = useRef(null);
  const catalogRequestRef = useRef(0);
  const selectionCallbackRef = useRef(onChange);
  selectionCallbackRef.current = onChange;
  const currentSelectionRef = useRef({ agentId, value });
  currentSelectionRef.current = { agentId, value };
  const isConnection = savedConnectionBinding(agentId);
  const agent = (!isConnection || savedConnectionOptions(catalog).some(option => option.id === agentId))
    ? catalog?.agents?.find(candidate => candidate.id === agentId) || null : null;
  const selection = normalizeSelection(value);
  const reasoningLevels = getAgentReasoningLevels(agent, selection?.model) || [];
  const showSpeedControl = showSpeed && (agentId === 'codex' || agent?.runtime === 'codex');

  const loadCatalog = useCallback(async (refresh = false) => {
    const requestId = ++catalogRequestRef.current;
    setLoading(true);
    setError('');
    if (savedConnectionBinding(agentId)) {
      setCatalog(null);
      const previous = normalizeSelection(currentSelectionRef.current.value);
      if (syncSelection) selectionCallbackRef.current?.({ model: previous?.model || '', reasoning: '', available: false });
    }
    try {
      const response = await apiFetch(`/api/agent/catalog${refresh ? '?refresh=true' : ''}`);
      const payload = await response.json();
      if (requestId !== catalogRequestRef.current || currentSelectionRef.current.agentId !== agentId) return;
      if (!response.ok) throw new Error(payload?.error || 'Failed to load agent models');
      if (savedConnectionBinding(agentId) && !savedConnectionOptions(payload).some(option => option.id === agentId)) {
        throw new Error('This saved connection revision is no longer available. Choose its current entry when starting a conversation.');
      }
      setCatalog(payload);
      if (!syncSelection) return;
      const selectedAgent = payload.agents?.find(candidate => candidate.id === agentId);
      const savedSelection = normalizeSelection(currentSelectionRef.current.value);
      if (savedConnectionBinding(agentId)) {
        selectionCallbackRef.current?.(selectionFor(selectedAgent, { id: savedSelection?.model || '' }, ''));
      } else if (!savedSelection && selectedAgent?.models?.length) {
        const defaultModel = selectedAgent.models.find(model => model.default) || selectedAgent.models[0];
        selectionCallbackRef.current?.(selectionFor(selectedAgent, defaultModel, initialReasoning(selectedAgent, defaultModel.id)));
      } else if (!savedSelection && selectedAgent?.runtime === 'v4') {
        selectionCallbackRef.current?.(selectionFor(selectedAgent, { id: '' }, ''));
      }
    } catch (loadError) {
      if (requestId === catalogRequestRef.current) setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === catalogRequestRef.current) setLoading(false);
    }
  }, [agentId, syncSelection]);

  useEffect(() => {
    setIsOpen(false);
    setSearch('');
    setCustomModel('');
    void loadCatalog(false);
    return () => { catalogRequestRef.current += 1; };
  }, [agentId]);

  useEffect(() => {
    if (syncSelection && selection && agent) {
      const liveSelection = selectionFor(agent, { id: selection.model }, selection.reasoning, selection.serviceTier);
      if (JSON.stringify(liveSelection) !== JSON.stringify(selection)) selectionCallbackRef.current?.(liveSelection);
    }
  }, [agent, selection?.model, selection?.reasoning, selection?.serviceTier, selection?.launchCommand, selection?.hostShell, selection?.available]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnOutsideClick = event => {
      if (!rootRef.current?.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [isOpen]);

  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (agent?.models || []).filter(model => !query || `${model.id} ${model.label}`.toLowerCase().includes(query));
  }, [agent, search]);

  const selectedModel = agent?.models?.find(model => model.id === selection?.model);
  const fallbackModel = !isConnection && (agent?.models?.find(model => model.default) || agent?.models?.[0]);
  const triggerLabel = loading && !selection ? 'Loading models…' : selectedModel?.label || selection?.model || fallbackModel?.label || (agent?.connectionProfile ? 'Choose a model ID' : agent?.runtime === 'v4' ? 'Provider default' : agent?.runtime === 'codex' ? 'Codex default' : 'Choose a model');

  const selectModel = model => {
    onChange?.(selectionFor(agent, model, selection?.reasoning || initialReasoning(agent, model.id), selection?.serviceTier));
    setIsOpen(false);
    setSearch('');
  };

  if (menuControls) {
    return <AgentModelMenu agent={agent} selection={selection} reasoningLevels={reasoningLevels} loading={loading} error={error}
      disabled={disabled} agentId={agentId} showSpeed={showSpeedControl} onRetry={() => void loadCatalog(true)} onSelectModel={selectModel} onChange={onChange} />;
  }

  if (compact) {
    const providerLabel = agent?.label || (agentId === 'codex' ? 'Codex' : agentId === 'claude' ? 'Claude Code' : 'Agent');
    return <ModelSettingsPopover value={selection} modelLabel={triggerLabel} providerLabel={providerLabel}
      mark={agentId === 'codex' ? 'C' : agentId === 'claude' ? 'A' : 'V'} disabled={disabled}
      triggerTitle={showSpeedControl ? 'Model, reasoning and speed' : 'Model and reasoning'}
      label={`${providerLabel} model ${triggerLabel}`} dialogLabel={`Choose ${providerLabel} model`}>
      <AgentModelMenu agent={agent} agentId={agentId} selection={selection} reasoningLevels={reasoningLevels} loading={loading} error={error}
        disabled={disabled} showSpeed={showSpeedControl} onRetry={() => void loadCatalog(true)} onSelectModel={selectModel} onChange={onChange} />
    </ModelSettingsPopover>;
  }

  return (
    <div className={`tv4-agent-model-picker agent-model-picker-surface${compact ? ' tv4-agent-model-picker-compact' : ''}`} ref={rootRef} onKeyDown={event => {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        setIsOpen(false);
        rootRef.current?.querySelector('.tv4-agent-model-trigger')?.focus();
      }
    }}>
      <div className="tv4-agent-model-picker-label-row">
        <label>{compact ? 'Model' : `${agent?.label || 'Agent'} model`}</label>
        <span>{agent?.status === 'auth-required' ? 'authentication required' : agent?.status === 'not-installed' ? 'not installed' : agent?.status === 'not-configured' ? 'API key required' : agent?.runtime === 'v4' ? 'V4 agent' : 'Ready'}</span>
      </div>
      {isConnection && error && <p role="alert" className="tv4-agent-model-state error">{error}</p>}
      <div className={"tv4-agent-model-picker-controls" + (reasoningLevels.length || (compact && showSpeedControl) ? "" : " tv4-agent-model-controls-single")}>
        <button
          type="button"
          className={`tv4-agent-model-trigger${isOpen ? ' active' : ''}`}
          onClick={() => setIsOpen(open => !open)}
          disabled={disabled}
          aria-expanded={isOpen && !disabled ? 'true' : 'false'}
          aria-haspopup="dialog"
          aria-label={`${agent?.label || 'Agent'} model ${triggerLabel}`}
        >
          <span className={`tv4-agent-model-mark tv4-agent-model-mark-${agentId || 'agent'}`} aria-hidden="true">{agentId === 'codex' ? 'C' : agentId === 'claude' ? 'A' : agent?.runtime === 'v4' ? 'V' : 'G'}</span>
          <span className="tv4-agent-model-trigger-copy"><strong>{triggerLabel}</strong><small>{agent?.label || 'Terminal v4'}</small></span>
          <span className="tv4-agent-model-chevron" aria-hidden="true">⌄</span>
        </button>
        {reasoningLevels.length > 0 && (compact ? <ComposerPicker
          label="Agent reasoning effort" menuTitle="Reasoning" displayPrefix="Reasoning: " className="composer-picker-reasoning"
          value={reasoningLevels.includes(selection?.reasoning) ? selection.reasoning : initialReasoning(agent, selection?.model)}
          options={reasoningLevels.map(level => ({ value: level, label: level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1) }))}
          disabled={!selection || disabled} onChange={reasoning => selection && onChange?.({ ...selection, reasoning })}
        /> : (
          <label className="tv4-agent-reasoning-field">
            <span>Reasoning</span>
            <select value={reasoningLevels.includes(selection?.reasoning) ? selection.reasoning : initialReasoning(agent, selection?.model)} onChange={event => selection && onChange?.({ ...selection, reasoning: event.target.value })} disabled={!selection || disabled} aria-label="Agent reasoning effort">
              {reasoningLevels.map(level => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
        ))}
        {compact && showSpeedControl && <ComposerPicker
          label="Codex speed" menuTitle="Speed" displayPrefix="Speed: " className="composer-picker-speed"
          value={selection?.serviceTier || ''} options={CODEX_SPEED_OPTIONS}
          disabled={!selection || disabled} onChange={tier => selection && onChange?.({ ...selection, serviceTier: tier || null })}
        />}
      </div>
      {agent?.id === 'codex' && agent?.help && (!compact || agent.status !== 'ready') && <p className="tv4-agent-model-state">{agent.help}</p>}
      {agent?.status !== 'ready' && <div className={`tv4-agent-status tv4-agent-status-${agent?.status || 'unknown'}`}>{agent?.status === 'auth-required' ? `Log in to ${agent.label} before starting it.` : agent?.status === 'not-installed' ? `${agent.label} is not installed on this host.` : agent?.status === 'not-configured' ? 'Add an API key for this provider in Settings.' : agent?.status === 'unsupported' ? 'This provider needs an additional V4 adapter.' : 'Agent availability is unknown.'}</div>}
      {isOpen && !disabled && (
        <div className="tv4-agent-model-popover" role="dialog" aria-label={`Choose ${agent?.label || 'agent'} model`}>
          <div className="tv4-agent-model-popover-header">
            <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search models…" aria-label={`Search ${agent?.label || 'agent'} models`} autoFocus />
            <button type="button" className="tv4-agent-model-refresh" onClick={() => void loadCatalog(true)} disabled={loading} aria-label="Refresh agent models" title="Refresh native agent status">↻</button>
          </div>
          {agent?.runtime === 'v4' && <div className="tv4-agent-custom-model">
            <label>Custom model ID<input value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="provider/model" maxLength={200} /></label>
            <button type="button" disabled={!customModel.trim()} onClick={() => selectModel({ id: customModel.trim() })}>Use custom model</button>
          </div>}
          <div className="tv4-agent-model-results">
            {loading && <div className="tv4-agent-model-state">Loading native agent catalog…</div>}
            {!loading && error && !isConnection && <div className="tv4-agent-model-state error">{error}</div>}
            {!loading && !error && visibleModels.length === 0 && <div className="tv4-agent-model-state">{agent?.runtime === 'v4' && !search ? 'Enter a model ID supported by this provider.' : 'No models match that search.'}</div>}
            {!loading && !error && visibleModels.map(model => (
              <button type="button" key={model.id} className={`tv4-agent-model-option${selection?.model === model.id ? ' selected' : ''}`} onClick={() => selectModel(model)} aria-label={model.label}>
                <span>{model.label}</span><small>{model.id}</small>{selection?.model === model.id && <span aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
