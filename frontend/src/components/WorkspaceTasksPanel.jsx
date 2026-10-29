import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './WorkspaceTasksPanel.css';

const nativeAgents = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const advancedUnavailable = 'Advanced scheduling is unavailable on this server. Update the server to create one-time or calendar schedules. Interval schedules are still available.';

async function supportsAdvancedTiming(signal) {
  try {
    const response = await apiFetch('/api/workspace/schedules/capabilities', { signal });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.advancedTimingProtocolVersion === 1;
  } catch { return false; }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function calendarTime(time, weekdays, timeZone) {
  const [hour, minute] = time.split(':').map(Number);
  return { hour, minute, weekdays: [...weekdays].sort(), ...(typeof timeZone === 'number' ? { utcOffsetMinutes: timeZone } : { timeZone }) };
}

function validTimeZone(timeZone) {
  try { new Intl.DateTimeFormat('en', { timeZone }); return !!timeZone; } catch { return false; }
}

export function describeSchedule(schedule, showZone = false) {
  if (schedule.runOnceAt != null) return `Once at ${new Date(schedule.runOnceAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  if (!schedule.at) return `Every ${Math.round(schedule.intervalSeconds / 60)} minutes`;
  const { hour, minute, weekdays } = schedule.at;
  const days = weekdays.join(',') === '1,2,3,4,5' ? 'Weekdays' : weekdays.length === 7 ? 'Every day' : weekdays.map(day => WEEKDAYS[day]).join(', ');
  const zone = schedule.at.timeZone || `UTC${schedule.at.utcOffsetMinutes >= 0 ? '+' : '-'}${Math.floor(Math.abs(schedule.at.utcOffsetMinutes) / 60)}:${String(Math.abs(schedule.at.utcOffsetMinutes) % 60).padStart(2, '0')} (fixed offset)`;
  return `${days} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}${showZone ? ` ${zone}` : ''}`;
}

export function WorkspaceTasksPanel({ workspacePath = '', currentSessionId, onInsertPrompt, latestAssistantText = '' }) {
  const [tasks, setTasks] = useState([]);
  const [agents, setAgents] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [schedules, setSchedules] = useState([]);
  const [advancedTiming, setAdvancedTiming] = useState(null);
  const [capabilityRefresh, setCapabilityRefresh] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState('claude');
  const [model, setModel] = useState('');
  const [scheduleName, setScheduleName] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState('3600');
  const [timing, setTiming] = useState('interval');
  const [runTime, setRunTime] = useState('09:00');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [onceAt, setOnceAt] = useState('');
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5]);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setAgents(null);
    setCatalogLoading(true);
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
    }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [workspacePath, catalogRefresh]);

  useEffect(() => {
    const controller = new AbortController();
    setAdvancedTiming(null);
    supportsAdvancedTiming(controller.signal).then(supported => {
      if (!controller.signal.aborted) setAdvancedTiming(supported);
    });
    return () => controller.abort();
  }, [workspacePath, capabilityRefresh]);

  const load = useCallback(async (signal) => {
    const version = generation.current;
    try {
      const response = await apiFetch('/api/workspace/tasks?' + new URLSearchParams({ path: workspacePath }), { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Unable to load tasks');
      if (!signal?.aborted && version === generation.current) {
        setTasks(data.tasks || []);
        setSchedules(data.schedules || []);
        setLoaded(true);
        setLoadError('');
      }
    } catch (failure) {
      if (!signal?.aborted && version === generation.current) setLoadError(failure.message || 'Unable to load tasks');
    }
  }, [workspacePath]);

  useEffect(() => {
    generation.current += 1;
    const controller = new AbortController();
    setTasks([]);
    setSchedules([]);
    setLoaded(false);
    setPending(false);
    setError(''); setLoadError('');
    load(controller.signal);
    const timer = setInterval(() => load(controller.signal), 5000);
    return () => { controller.abort(); clearInterval(timer); generation.current += 1; };
  }, [load]);

  const mutate = async (url, options, clearDraft = false, advanced = false) => {
    const version = generation.current;
    setPending(true);
    setError('');
    try {
      if (advanced) {
        const supported = await supportsAdvancedTiming();
        if (version !== generation.current) return;
        if (!supported) { setAdvancedTiming(false); return; }
      }
      const response = await apiFetch(url, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Unable to update task');
      if (version !== generation.current) return;
      if (clearDraft) setPrompt(current => current === prompt ? '' : current);
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
  const onceTimestamp = Date.parse(onceAt + 'Z');
  const validOnce = Number.isFinite(onceTimestamp) && onceTimestamp > Date.now() && new Date(onceTimestamp).toISOString().slice(0, 16) === onceAt;
  const canQueue = loaded && !catalogLoading && workspacePath && prompt.trim() && !pending && selectedAgent && selectedAgent.available !== false;
  return (
    <section className="workspace-tasks" aria-label="Workspace tasks and schedules">
      <header><h3>Tasks & schedules</h3><p>Run an agent in this workspace and keep its result with your conversation.</p></header>
      {catalogError && <p role="status">{catalogError}</p>}
      {agents?.length === 0 && <p role="status">No compatible task agents are available. Install or enable an agent that supports durable tasks, then recheck.</p>}
      {(catalogError || agents?.length === 0) && <button type="button" disabled={catalogLoading || pending} onClick={() => setCatalogRefresh(value => value + 1)}>Recheck task agents</button>}
      {!workspacePath && <p>Choose a workspace to queue tasks.</p>}
      {(error || loadError) && <div role="alert">{error}{loadError && <><p>{loadError}</p><p>Task list may be out of date. Retry to check its current state.</p></>}<button type="button" onClick={() => { setError(''); load(undefined); }}>Retry tasks</button></div>}
      <form onSubmit={(event) => { event.preventDefault(); if (canQueue) mutate('/api/workspace/tasks', { method: 'POST', body: input }, true); }}>
        <div className="workspace-task-options">
          <label>Task agent<select value={provider} disabled={catalogLoading || agentChoices.length === 0} onChange={(event) => setProvider(event.target.value)}>{agentChoices.length === 0 && <option value="">No compatible agents</option>}{agentChoices.map(agent => <option key={agent.id} value={agent.id} disabled={agent.available === false}>{agent.label}{agent.available === false ? ' (unavailable)' : ''}</option>)}</select></label>
          <label>Model (optional)<input value={model} maxLength={200} onChange={(event) => setModel(event.target.value)} placeholder="Agent default" /></label>
        </div>
        <label>Task prompt<textarea value={prompt} maxLength={32000} rows={4} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe what this task should accomplish…" /></label>
        <div className="workspace-task-actions">
          {latestAssistantText && <button type="button" onClick={() => setPrompt(latestAssistantText.slice(0, 32000))}>Use latest answer</button>}
          <button type="submit" disabled={!canQueue}>Queue task</button>
        </div>
        <details className="workspace-schedule-editor"><summary>Make a schedule</summary>
          <label>Schedule name<input value={scheduleName} maxLength={80} onChange={(event) => setScheduleName(event.target.value)} /></label>
          {advancedTiming === false && <p role="status">{advancedUnavailable} <button type="button" onClick={() => setCapabilityRefresh(value => value + 1)}>Recheck scheduling support</button></p>}
          <label>Runs<select value={timing} onChange={(event) => setTiming(event.target.value)}><option value="interval">On a repeating interval</option><option value="calendar">At a time on chosen days</option><option value="once">Once</option></select></label>
          {timing === 'interval' ? <label>Repeat every<select value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)}><option value="300">5 minutes</option><option value="3600">Hour</option><option value="86400">Day</option><option value="604800">Week</option></select></label>
            : timing === 'once' ? <label>Date and time (UTC)<input type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} /></label>
            : <>
              <label>Time<input type="time" value={runTime} onChange={(event) => setRunTime(event.target.value)} /></label>
              <label>Time zone (IANA)<input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/New_York" /></label>
              <p>Daylight-saving gaps are skipped; repeated times run once at the earlier occurrence.</p>
              <fieldset className="workspace-schedule-days"><legend>Days</legend>
                {WEEKDAYS.map((label, day) => <label key={label} className="workspace-schedule-checkbox"><input type="checkbox" checked={weekdays.includes(day)}
                  onChange={(event) => setWeekdays(current => event.target.checked ? [...current, day].sort() : current.filter(value => value !== day))} />{label}</label>)}
              </fieldset>
            </>}
          <label className="workspace-schedule-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable this schedule</label>
          <button type="button" disabled={!canQueue || !scheduleName.trim() || (timing !== 'interval' && advancedTiming !== true) || (timing === 'calendar' && (!weekdays.length || !runTime || !validTimeZone(timeZone))) || (timing === 'once' && !validOnce)} onClick={() => mutate('/api/workspace/schedules', { method: 'POST', body: { ...input, name: scheduleName.trim(), enabled,
            intervalSeconds: timing === 'interval' ? Number(intervalSeconds) : 0,
            ...(timing === 'calendar' ? { at: calendarTime(runTime, weekdays, timeZone) } : {}),
            ...(timing === 'once' ? { runOnceAt: onceTimestamp } : {}) } }, false, timing !== 'interval')}>Create schedule</button>
          <p>Enabled schedules run while the app server is running. Missed intervals are combined into one run.</p>
        </details>
      </form>
      <div className="workspace-task-list">
        {!loaded && !error && !loadError && <p role="status">Loading tasks…</p>}
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
            <div className="workspace-task-record-heading"><strong>{schedule.name}</strong><span>{schedule.runOnceAt != null && schedule.lastTaskId ? 'Triggered' : schedule.enabled ? 'Enabled' : 'Paused'}</span></div>
            <p>{schedule.provider} · {describeSchedule(schedule, true)}</p>
            {schedule.nextRunAt && <small>Next run: {new Date(schedule.nextRunAt).toLocaleString()}</small>}
            <div className="workspace-task-actions">
              {!(schedule.runOnceAt != null && schedule.lastTaskId) && <button type="button" disabled={pending} aria-label={(schedule.enabled ? 'Pause ' : 'Enable ') + schedule.name} onClick={() => mutate('/api/workspace/schedules/' + schedule.id, { method: 'PATCH', body: { enabled: !schedule.enabled } })}>{schedule.enabled ? 'Pause' : 'Enable'}</button>}
              {!(schedule.runOnceAt != null && schedule.lastTaskId) && <button type="button" disabled={pending} aria-label={'Run ' + schedule.name + ' now'} onClick={() => mutate('/api/workspace/schedules/' + schedule.id + '/run', { method: 'POST' })}>Run now</button>}
              <button type="button" disabled={pending} aria-label={'Remove ' + schedule.name} onClick={() => mutate('/api/workspace/schedules/' + schedule.id, { method: 'DELETE' })}>Remove schedule</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}


