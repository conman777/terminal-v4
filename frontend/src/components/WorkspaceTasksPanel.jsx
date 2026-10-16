import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './WorkspaceTasksPanel.css';

const nativeAgents = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: 'hermes', label: 'Hermes' }];
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export function WorkspaceTasksPanel({ workspacePath = '', currentSessionId, onInsertPrompt, latestAssistantText = '' }) {
  const [tasks, setTasks] = useState([]);
  const [agents, setAgents] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [schedules, setSchedules] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState('claude');
  const [model, setModel] = useState('');
  const [scheduleName, setScheduleName] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState('3600');
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setAgents(null);
    setCatalogError('');
    apiFetch('/api/agent/catalog', { signal: controller.signal }).then(async response => {
      const catalog = await response.json();
      if (!response.ok || !Array.isArray(catalog.agents)) throw new Error('Agent catalog unavailable');
      if (controller.signal.aborted) return;
      const choices = catalog.agents.filter(agent => agent.capabilities?.durableTasks);
      setAgents(choices);
      setProvider(current => choices.some(agent => agent.id === current) ? current : choices.find(agent => agent.available)?.id || choices[0]?.id || 'claude');
    }).catch(() => {
      if (!controller.signal.aborted) setCatalogError('Agent availability could not be checked. Native launch failures will be recorded with the task.');
    });
    return () => controller.abort();
  }, [workspacePath]);

  const load = useCallback(async (signal, showError = true) => {
    const version = generation.current;
    try {
      const response = await apiFetch('/api/workspace/tasks?' + new URLSearchParams({ path: workspacePath }), { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Unable to load tasks');
      if (!signal?.aborted && version === generation.current) {
        setTasks(data.tasks || []);
        setSchedules(data.schedules || []);
        setLoaded(true);
      }
    } catch (failure) {
      if (!signal?.aborted && version === generation.current && showError) setError(failure.message || 'Unable to load tasks');
    }
  }, [workspacePath]);

  useEffect(() => {
    generation.current += 1;
    const controller = new AbortController();
    setTasks([]);
    setSchedules([]);
    setLoaded(false);
    setPending(false);
    setError('');
    load(controller.signal);
    const timer = setInterval(() => load(controller.signal, false), 5000);
    return () => { controller.abort(); clearInterval(timer); generation.current += 1; };
  }, [load]);

  const mutate = async (url, options, clearDraft = false) => {
    const version = generation.current;
    setPending(true);
    setError('');
    try {
      const response = await apiFetch(url, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Unable to update task');
      if (version !== generation.current) return;
      if (clearDraft) setPrompt('');
      await load(undefined);
    } catch (failure) {
      if (version === generation.current) setError(failure.message || 'Unable to update task');
    } finally {
      if (version === generation.current) setPending(false);
    }
  };

  const input = { workspacePath, provider, prompt: prompt.trim(), model: model.trim() || null, parentSessionId: currentSessionId || null, parentTaskId: null };
  const agentChoices = agents || nativeAgents;
  const selectedAgent = agentChoices.find(agent => agent.id === provider);
  const canQueue = loaded && workspacePath && prompt.trim() && !pending && selectedAgent && selectedAgent.available !== false;
  return (
    <section className="workspace-tasks" aria-label="Workspace tasks and schedules">
      <header><h3>Tasks & schedules</h3><p>Run an agent in this workspace and keep its result with your conversation.</p></header>
      {catalogError && <p role="status">{catalogError}</p>}
      {!workspacePath && <p>Choose a workspace to queue tasks.</p>}
      {error && <div role="alert">{error}<button type="button" onClick={() => { setError(''); load(undefined); }}>Retry tasks</button></div>}
      <form onSubmit={(event) => { event.preventDefault(); if (canQueue) mutate('/api/workspace/tasks', { method: 'POST', body: input }, true); }}>
        <div className="workspace-task-options">
          <label>Task agent<select value={provider} onChange={(event) => setProvider(event.target.value)}>{agentChoices.map(agent => <option key={agent.id} value={agent.id} disabled={agent.available === false}>{agent.label}{agent.available === false ? ' (unavailable)' : ''}</option>)}</select></label>
          <label>Model (optional)<input value={model} maxLength={200} onChange={(event) => setModel(event.target.value)} placeholder="Agent default" /></label>
        </div>
        <label>Task prompt<textarea value={prompt} maxLength={32000} rows={4} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe what this task should accomplish…" /></label>
        <div className="workspace-task-actions">
          {latestAssistantText && <button type="button" onClick={() => setPrompt(latestAssistantText.slice(0, 32000))}>Use latest answer</button>}
          <button type="submit" disabled={!canQueue}>Queue task</button>
        </div>
        <details className="workspace-schedule-editor"><summary>Make a recurring schedule</summary>
          <label>Schedule name<input value={scheduleName} maxLength={80} onChange={(event) => setScheduleName(event.target.value)} /></label>
          <label>Repeat every<select value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)}><option value="300">5 minutes</option><option value="3600">Hour</option><option value="86400">Day</option><option value="604800">Week</option></select></label>
          <label className="workspace-schedule-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable this schedule</label>
          <button type="button" disabled={!canQueue || !scheduleName.trim()} onClick={() => mutate('/api/workspace/schedules', { method: 'POST', body: { ...input, name: scheduleName.trim(), intervalSeconds: Number(intervalSeconds), enabled } })}>Create schedule</button>
          <p>Enabled schedules run while the app server is running. Missed intervals are combined into one run.</p>
        </details>
      </form>
      <div className="workspace-task-list">
        {!loaded && !error && <p role="status">Loading tasks…</p>}
        {loaded && tasks.length === 0 && <p>No tasks yet.</p>}
        {tasks.map((task) => (
          <article className="workspace-task-record" key={task.id}>
            <div className="workspace-task-record-heading"><strong>{task.provider}</strong><span>{task.status}</span></div>
            <p>{task.prompt}</p>
            {task.parentSessionId && <small>Linked to conversation {task.parentSessionId}</small>}
            {task.parentTaskId && <small>Child of task {task.parentTaskId}</small>}
            {(task.result || task.output) && <details open={terminalStatuses.has(task.status)}><summary>Agent result</summary><pre>{task.result || task.output}</pre></details>}
            {task.outputTruncated && <small>Output reached the saved result limit.</small>}
            {(task.beforeCheckpointId || task.afterCheckpointId) && <small>Change checkpoints saved for review.</small>}
            {task.error && <p className="workspace-task-error">{task.error}</p>}
            {task.events?.length > 0 && <details><summary>Task activity</summary><ul>{task.events.map((event, index) => <li key={index}>{event.message}</li>)}</ul></details>}
            <div className="workspace-task-actions">
              {!terminalStatuses.has(task.status) && <button type="button" disabled={pending || task.status === 'cancelling'} onClick={() => mutate('/api/workspace/tasks/' + task.id + '/cancel', { method: 'POST' })}>Cancel task</button>}
              {terminalStatuses.has(task.status) && (task.result || task.output) && onInsertPrompt && <button type="button" onClick={() => onInsertPrompt('Task result (' + task.provider + '):\n' + (task.result || task.output))}>Add result to prompt</button>}
              {terminalStatuses.has(task.status) && <button type="button" disabled={pending} onClick={() => mutate('/api/workspace/tasks/' + task.id, { method: 'DELETE' })}>Remove task</button>}
            </div>
          </article>
        ))}
      </div>
      <div className="workspace-schedule-list">
        {schedules.map((schedule) => (
          <article className="workspace-task-record" key={schedule.id}>
            <div className="workspace-task-record-heading"><strong>{schedule.name}</strong><span>{schedule.enabled ? 'Enabled' : 'Paused'}</span></div>
            <p>{schedule.provider} · Every {Math.round(schedule.intervalSeconds / 60)} minutes</p>
            {schedule.nextRunAt && <small>Next run: {new Date(schedule.nextRunAt).toLocaleString()}</small>}
            <div className="workspace-task-actions">
              <button type="button" disabled={pending} aria-label={(schedule.enabled ? 'Pause ' : 'Enable ') + schedule.name} onClick={() => mutate('/api/workspace/schedules/' + schedule.id, { method: 'PATCH', body: { enabled: !schedule.enabled } })}>{schedule.enabled ? 'Pause' : 'Enable'}</button>
              <button type="button" disabled={pending} aria-label={'Run ' + schedule.name + ' now'} onClick={() => mutate('/api/workspace/schedules/' + schedule.id + '/run', { method: 'POST' })}>Run now</button>
              <button type="button" disabled={pending} aria-label={'Remove ' + schedule.name} onClick={() => mutate('/api/workspace/schedules/' + schedule.id, { method: 'DELETE' })}>Remove schedule</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}


