import { useId, useRef, useState } from 'react';
import { CODEX_SPEED_OPTIONS } from '../utils/agentServiceTier';
import './AgentModelPicker.css';

const reasoningLabel = level => level === 'xhigh' ? 'Extra high' : level ? level.charAt(0).toUpperCase() + level.slice(1) : 'Default';

export function AgentModelMenu({ agent, agentId = 'codex', showSpeed = agentId === 'codex' || agent?.runtime === 'codex', selection, reasoningLevels, loading, error, disabled, onRetry, onSelectModel, onChange }) {
  const [view, setView] = useState('models');
  const [search, setSearch] = useState('');
  const [customModel, setCustomModel] = useState('');
  const searchRef = useRef(null);
  const rootRef = useRef(null);
  const descriptionId = useId();
  const isDisabled = disabled || loading || !agent;
  const speed = CODEX_SPEED_OPTIONS.find(option => option.value === (selection?.serviceTier || ''));
  const models = agent?.models || [];
  const currentMissing = selection?.model && !models.some(model => model.id === selection.model);
  const visibleModels = (currentMissing ? [{ id: selection.model, label: selection.model }, ...models] : models)
    .filter(model => `${model.label || ''} ${model.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const options = view === 'models'
    ? visibleModels.map(model => ({ value: model.id, label: model.label || model.id, model }))
    : view === 'reasoning'
      ? reasoningLevels.map(level => ({ value: level, label: reasoningLabel(level) })) : CODEX_SPEED_OPTIONS;
  const selected = view === 'models' ? selection?.model : view === 'reasoning' ? selection?.reasoning : selection?.serviceTier || '';
  const providerLabel = agent?.label || (agentId === 'codex' ? 'Codex' : 'Agent');
  const title = view === 'models' ? `${providerLabel} models` : view === 'reasoning' ? 'Reasoning effort' : view === 'custom' ? 'Custom model' : 'Response speed';
  const back = () => {
    setView('models');
    rootRef.current?.querySelector('.agent-model-menu-footer button')?.focus({ preventScroll: true });
  };

  const choose = option => {
    if (view === 'models') onSelectModel(option.model);
    else if (selection) onChange?.({ ...selection, ...(view === 'reasoning' ? { reasoning: option.value } : { serviceTier: option.value || null }) });
    setSearch('');
    setView('models');
    rootRef.current?.querySelector('.agent-model-menu-footer button')?.focus({ preventScroll: true });
  };

  const handleKeys = event => {
    if (event.key === 'Escape' && view !== 'models') {
      event.preventDefault();
      event.stopPropagation();
      back();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === searchRef.current && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const rows = [...rootRef.current.querySelectorAll('[role="option"]:not(:disabled)')];
    if (!rows.length) return;
    event.preventDefault();
    event.stopPropagation();
    const index = rows.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : index < 0 ? event.key === 'ArrowUp' ? rows.length - 1 : 0
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus({ preventScroll: true });
    rows[next].scrollIntoView?.({ block: 'nearest' });
  };

  return <div className="agent-model-menu" ref={rootRef} onKeyDown={handleKeys}>
    {view === 'models' ? <label className="agent-model-menu-search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
      <input ref={searchRef} type="search" aria-label={`Search ${providerLabel} models`} placeholder="Search models…" value={search} onChange={event => setSearch(event.target.value)} />
    </label> : <button type="button" className="agent-model-menu-back" onClick={back}><span aria-hidden="true">‹</span> {title}</button>}
    {view === 'custom' ? <div className="agent-model-menu-custom">
      <label>Custom model ID<input aria-label="Custom model ID" value={customModel} onChange={event => setCustomModel(event.target.value)} maxLength={200} placeholder="provider/model" /></label>
      <button type="button" disabled={disabled || !agent || !customModel.trim()} onClick={() => { onSelectModel({ id: customModel.trim() }); setCustomModel(''); back(); }}>Use custom model</button>
    </div> : <div className="agent-model-menu-list" role="listbox" aria-label={title} aria-busy={loading || undefined}>
      {loading ? <p className="agent-model-menu-state" role="status">Loading models…</p> : options.map((option, index) => <button type="button" role="option" key={option.value}
        aria-label={option.label} aria-describedby={option.description ? `${descriptionId}-${index}` : undefined} aria-selected={selected === option.value} disabled={isDisabled} className="agent-model-menu-option" onClick={() => choose(option)}>
        <span className="agent-model-menu-option-copy"><span>{option.label}</span>{option.description && <small id={`${descriptionId}-${index}`}>{option.description}</small>}</span>
        {selected === option.value && <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg>}
      </button>)}
      {!loading && !error && !options.length && <p className="agent-model-menu-state">{search ? 'No models match your search.' : 'No models available.'}</p>}
    </div>}
    {error && <div className="agent-model-menu-error" role="alert">{error}<button type="button" onClick={onRetry}>Try again</button></div>}
    <div className="agent-model-menu-footer">
      <button type="button" aria-label={`Reasoning: ${reasoningLabel(selection?.reasoning)}`} aria-pressed={view === 'reasoning'} disabled={isDisabled || !selection || !reasoningLevels.length} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setSearch(''); setView('reasoning'); }}>
        <span>Reasoning</span> {reasoningLabel(selection?.reasoning)} <span aria-hidden="true">⌄</span>
      </button>
      {showSpeed && <button type="button" aria-label={`Speed: ${speed?.label || 'Default'}`} aria-pressed={view === 'speed'} disabled={isDisabled || !selection} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setSearch(''); setView('speed'); }}>
        <span>Speed</span> {speed?.label || 'Default'} <span aria-hidden="true">⌄</span>
      </button>}
      {agent?.runtime === 'v4' && <button type="button" aria-label="Enter custom model ID" disabled={disabled} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setView('custom'); }}>Custom model…</button>}
    </div>
  </div>;
}
