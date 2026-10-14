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
  };
}

function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || typeof value.model !== 'string' || !value.model.trim()) return null;
  return {
    model: value.model.trim(),
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
    ...(typeof value.launchCommand === 'string' ? { launchCommand: value.launchCommand } : {}),
  };
}

export function AgentModelPicker({ agentId, value, onChange }) {
  const [catalog, setCatalog] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const rootRef = useRef(null);
  const agent = catalog?.agents?.find(candidate => candidate.id === agentId) || null;
  const selection = normalizeSelection(value);

  const loadCatalog = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch(`/api/agent/catalog${refresh ? '?refresh=true' : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || 'Failed to load agent models');
      setCatalog(payload);
      const selectedAgent = payload.agents?.find(candidate => candidate.id === agentId);
      if (!normalizeSelection(value) && selectedAgent?.models?.length) {
        const defaultModel = selectedAgent.models.find(model => model.default) || selectedAgent.models[0];
        onChange?.(selectionFor(selectedAgent, defaultModel, initialReasoning(selectedAgent)));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [agentId, onChange, value]);

  useEffect(() => { void loadCatalog(false); }, [agentId]);

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
  const triggerLabel = loading && !selection ? 'Loading models…' : selectedModel?.label || selection?.model || fallbackModel?.label || 'Choose a model';

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
      <div className="tv4-agent-model-picker-controls">
        <button
          type="button"
          className={`tv4-agent-model-trigger${isOpen ? ' active' : ''}`}
          onClick={() => setIsOpen(open => !open)}
          aria-expanded={isOpen ? 'true' : 'false'}
          aria-haspopup="dialog"
          aria-label={`${agent?.label || 'Agent'} model ${triggerLabel}`}
        >
          <span className={`tv4-agent-model-mark tv4-agent-model-mark-${agentId || 'agent'}`} aria-hidden="true">{agentId === 'codex' ? 'C' : agentId === 'claude' ? 'A' : 'G'}</span>
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
          <div className="tv4-agent-model-results">
            {loading && <div className="tv4-agent-model-state">Loading native agent catalog…</div>}
            {!loading && error && <div className="tv4-agent-model-state error">{error}</div>}
            {!loading && !error && visibleModels.length === 0 && <div className="tv4-agent-model-state">No models match that search.</div>}
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
