import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';

function initialReasoning(agent) {
  if (agent?.reasoningLevels?.includes('xhigh')) return 'xhigh';
  if (agent?.reasoningLevels?.includes('high')) return 'high';
  return agent?.reasoningLevels?.[0] || '';
}

function selectionFor(agent, model, reasoning) {
  return {
    model: model.id,
    reasoning,
    ...(agent?.launchCommand ? { launchCommand: agent.launchCommand } : {}),
    ...(agent?.hostShell ? { hostShell: agent.hostShell } : {}),
    ...(typeof agent?.available === 'boolean' ? { available: agent.available } : {}),
  };
}

function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || typeof value.model !== 'string') return null;
  return {
    model: value.model.trim(),
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
    ...(typeof value.launchCommand === 'string' ? { launchCommand: value.launchCommand } : {}),
    ...(typeof value.hostShell === 'string' ? { hostShell: value.hostShell } : {}),
    ...(typeof value.available === 'boolean' ? { available: value.available } : {}),
  };
}

export function AgentModelPicker({ agentId, value, onChange }) {
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
  const agent = catalog?.agents?.find(candidate => candidate.id === agentId) || null;
  const selection = normalizeSelection(value);

  const loadCatalog = useCallback(async (refresh = false) => {
    const requestId = ++catalogRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch(`/api/agent/catalog${refresh ? '?refresh=true' : ''}`);
      const payload = await response.json();
      if (requestId !== catalogRequestRef.current) return;
      if (!response.ok) throw new Error(payload?.error || 'Failed to load agent models');
      setCatalog(payload);
      const selectedAgent = payload.agents?.find(candidate => candidate.id === agentId);
      const savedSelection = normalizeSelection(value);
      if (!savedSelection && selectedAgent?.models?.length) {
        const defaultModel = selectedAgent.models.find(model => model.default) || selectedAgent.models[0];
        onChange?.(selectionFor(selectedAgent, defaultModel, initialReasoning(selectedAgent)));
      } else if (!savedSelection && selectedAgent?.id === 'hermes') {
        onChange?.(selectionFor(selectedAgent, { id: '' }, ''));
      }
    } catch (loadError) {
      if (requestId === catalogRequestRef.current) setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === catalogRequestRef.current) setLoading(false);
    }
  }, [agentId, onChange, value]);

  useEffect(() => { void loadCatalog(false); return () => { catalogRequestRef.current += 1; }; }, [agentId]);

  useEffect(() => {
    if (selection && agent) {
      const liveSelection = selectionFor(agent, { id: selection.model }, selection.reasoning);
      if (JSON.stringify(liveSelection) !== JSON.stringify(selection)) selectionCallbackRef.current?.(liveSelection);
    }
  }, [agent, selection?.model, selection?.reasoning, selection?.launchCommand, selection?.hostShell, selection?.available]);

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
  const fallbackModel = agent?.models?.find(model => model.default) || agent?.models?.[0];
  const triggerLabel = loading && !selection ? 'Loading models…' : selectedModel?.label || selection?.model || fallbackModel?.label || (agentId === 'hermes' ? 'Provider default' : 'Choose a model');

  const selectModel = model => {
    onChange?.(selectionFor(agent, model, selection?.reasoning || initialReasoning(agent)));
    setIsOpen(false);
    setSearch('');
  };

  return (
    <div className="tv4-agent-model-picker" ref={rootRef}>
      <div className="tv4-agent-model-picker-label-row">
        <label>{agent?.label || 'Agent'} model</label>
        <span>{agent?.status === 'auth-required' ? 'authentication required' : agent?.status === 'not-installed' ? 'not installed' : agent?.status === 'not-configured' ? 'provider runtime unavailable' : 'native Terminal v4 launcher'}</span>
      </div>
      <div className={"tv4-agent-model-picker-controls" + (agent?.reasoningLevels?.length ? "" : " tv4-agent-model-controls-single")}>
        <button
          type="button"
          className={`tv4-agent-model-trigger${isOpen ? ' active' : ''}`}
          onClick={() => setIsOpen(open => !open)}
          aria-expanded={isOpen ? 'true' : 'false'}
          aria-haspopup="dialog"
          aria-label={`${agent?.label || 'Agent'} model ${triggerLabel}`}
        >
          <span className={`tv4-agent-model-mark tv4-agent-model-mark-${agentId || 'agent'}`} aria-hidden="true">{agentId === 'codex' ? 'C' : agentId === 'claude' ? 'A' : agentId === 'hermes' ? 'H' : 'G'}</span>
          <span className="tv4-agent-model-trigger-copy"><strong>{triggerLabel}</strong><small>{agent?.label || 'Terminal v4'}</small></span>
          <span className="tv4-agent-model-chevron" aria-hidden="true">⌄</span>
        </button>
        {agent?.reasoningLevels?.length > 0 && (
          <label className="tv4-agent-reasoning-field">
            <span>Reasoning</span>
            <select value={selection?.reasoning || initialReasoning(agent)} onChange={event => selection && onChange?.({ ...selection, reasoning: event.target.value })} disabled={!selection} aria-label="Agent reasoning effort">
              {agent.reasoningLevels.map(level => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
        )}
      </div>
      {agent?.status !== 'ready' && <div className={`tv4-agent-status tv4-agent-status-${agent?.status || 'unknown'}`}>{agent?.status === 'auth-required' ? `Log in to ${agent.label} before starting it.` : agent?.status === 'not-installed' ? `${agent.label} is not installed on this host.` : agent?.status === 'not-configured' ? 'This provider needs a Terminal v4 runtime adapter before it can start.' : 'Agent availability is unknown.'}</div>}
      {isOpen && (
        <div className="tv4-agent-model-popover" role="dialog" aria-label={`Choose ${agent?.label || 'agent'} model`}>
          <div className="tv4-agent-model-popover-header">
            <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search models…" aria-label={`Search ${agent?.label || 'agent'} models`} autoFocus />
            <button type="button" className="tv4-agent-model-refresh" onClick={() => void loadCatalog(true)} disabled={loading} aria-label="Refresh agent models" title="Refresh native agent status">↻</button>
          </div>
          {agentId === 'hermes' && <div className="tv4-agent-custom-model">
            <button type="button" className="tv4-agent-model-option" onClick={() => selectModel({ id: '' })}>Provider default</button>
            <label>Custom model ID<input value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="provider/model" maxLength={256} /></label>
            <button type="button" disabled={!customModel.trim()} onClick={() => selectModel({ id: customModel.trim() })}>Use custom model</button>
          </div>}
          <div className="tv4-agent-model-results">
            {loading && <div className="tv4-agent-model-state">Loading native agent catalog…</div>}
            {!loading && error && <div className="tv4-agent-model-state error">{error}</div>}
            {!loading && !error && visibleModels.length === 0 && <div className="tv4-agent-model-state">{agentId === 'hermes' && !search ? 'Use your configured Hermes model or enter a custom model ID.' : 'No models match that search.'}</div>}
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
