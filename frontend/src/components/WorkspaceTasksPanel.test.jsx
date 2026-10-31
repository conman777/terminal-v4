import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceTasksPanel } from './WorkspaceTasksPanel';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
const path = 'C:/projects/demo';
const task = { id: 'task-one', provider: 'codex', prompt: 'Review', status: 'completed', result: 'Review finished.', output: 'Review finished.', createdAt: 1000, events: [], parentSessionId: 'ss-parent' };
const schedule = { id: 'schedule-one', name: 'Morning review', provider: 'claude', enabled: false, intervalSeconds: 3600 };
describe('WorkspaceTasksPanel', () => {
  beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [], schedules: [] }) }); });

  it('queues selected native agent tasks linked to the current conversation', async () => {
    render(<WorkspaceTasksPanel workspacePath={path} currentSessionId="ss-parent" />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Check build' } });
    fireEvent.change(screen.getByLabelText('Task agent'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/tasks', { method: 'POST', body: { workspacePath: path, provider: 'codex', prompt: 'Check build', model: null, parentSessionId: 'ss-parent', parentTaskId: null } }));
  });

  it('creates disabled recurring schedules until the user explicitly enables one', async () => {
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Check build' } });
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules', { method: 'POST', body: { workspacePath: path, provider: 'claude', prompt: 'Check build', model: null, parentSessionId: null, parentTaskId: null, name: 'Review', intervalSeconds: 3600, enabled: false } }));
  });

  it('shows native results, inserts them for review, and enables or runs schedules explicitly', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [task], schedules: [schedule] }) });
    const onInsertPrompt = vi.fn();
    render(<WorkspaceTasksPanel workspacePath={path} onInsertPrompt={onInsertPrompt} />);
    expect(await screen.findByText('Review finished.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add result to prompt' }));
    expect(onInsertPrompt).toHaveBeenCalledWith('Task result (codex):\nReview finished.');
    fireEvent.click(screen.getByRole('button', { name: 'Enable Morning review' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules/schedule-one', { method: 'PATCH', body: { enabled: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Morning review now' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules/schedule-one/run', { method: 'POST' }));
  });

  it('creates a schedule that delivers to Telegram only when the box is ticked', async () => {
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Check build' } });
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByLabelText('Send each result to my paired Telegram chat'));
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules', { method: 'POST', body: { workspacePath: path, provider: 'claude', prompt: 'Check build', model: null, parentSessionId: null, parentTaskId: null, name: 'Review', intervalSeconds: 3600, deliverTo: 'telegram', enabled: false } }));
  });

  it('toggles Telegram delivery on a schedule and shows each task\'s honest delivery status', async () => {
    const delivered = { ...task, id: 'task-two', deliverTo: 'telegram', deliveryStatus: 'delivered' };
    const skipped = { ...task, id: 'task-three', deliverTo: 'telegram', deliveryStatus: 'skipped', deliveryReason: 'No Telegram chat is paired' };
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [delivered, skipped, task], schedules: [{ ...schedule, deliverTo: 'telegram' }] }) });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    expect(await screen.findByText('Telegram delivery: delivered')).toBeInTheDocument();
    expect(screen.getByText('Telegram delivery: skipped (No Telegram chat is paired)')).toBeInTheDocument();
    expect(screen.getAllByText(/Telegram delivery:/)).toHaveLength(2);
    const toggle = screen.getByLabelText('Send Morning review results to Telegram');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules/schedule-one', { method: 'PATCH', body: { deliverTo: null } }));
  });

  it('shows the stale one-shot enable error and retains the explicit Run now action', async () => {
    const message = 'This one-shot time has passed. Use Run now or create a new schedule for a future time.';
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'PATCH'
      ? { ok: false, json: async () => ({ error: message }) }
      : { ok: true, json: async () => ({ tasks: [], schedules: [{ ...schedule, runOnceAt: 1 }] }) });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Morning review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    fireEvent.click(screen.getByRole('button', { name: 'Run Morning review now' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules/schedule-one/run', { method: 'POST' }));
  });

  it('retains the draft and reports failed queue requests', async () => {
    apiFetch.mockImplementation(async (_url, options) => options?.method ? { ok: false, json: async () => ({ error: 'Agent unavailable' }) } : { ok: true, json: async () => ({ tasks: [], schedules: [] }) });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Keep draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent unavailable');
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Keep draft');
  });
});


describe('WorkspaceTasksPanel provider adapters', () => {
  it('queues available API adapters and disables unconfigured providers from the live catalog', async () => {
    apiFetch.mockImplementation(async url => ({ ok: true, json: async () => url === '/api/agent/catalog'
      ? { agents: [
        { id: 'claude', label: 'Claude Code', available: true, capabilities: { durableTasks: true } },
        { id: 'openai-api', label: 'OpenAI API', available: true, capabilities: { durableTasks: true } },
        { id: 'deepseek', label: 'DeepSeek', available: false, capabilities: { durableTasks: true } },
        { id: 'vertex', label: 'Vertex', available: false, capabilities: { durableTasks: false } },
      ] } : { tasks: [], schedules: [] } }));
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByRole('option', { name: 'OpenAI API' });
    expect(screen.getByRole('option', { name: /DeepSeek/ })).toBeDisabled();
    expect(screen.queryByRole('option', { name: 'Vertex' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Task agent'), { target: { value: 'openai-api' } });
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Review the patch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/tasks', {
      method: 'POST', body: { workspacePath: path, provider: 'openai-api', prompt: 'Review the patch', model: null, parentSessionId: null, parentTaskId: null }
    }));
  });
});

it('preserves text entered while an earlier task is being queued', async () => {
  let finishQueue;
  apiFetch.mockImplementation(async (url, options) => options?.method === 'POST'
    ? new Promise(resolve => { finishQueue = () => resolve({ ok: true, json: async () => ({ id: 'queued' }) }); })
    : { ok: true, json: async () => url === '/api/agent/catalog' ? { agents: [{ id: 'codex', label: 'Codex', available: true, capabilities: { durableTasks: true } }] } : { tasks: [], schedules: [] } });
  render(<WorkspaceTasksPanel workspacePath={path} />);
  await screen.findByText('No tasks yet.');
  fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Submitted task' } });
  fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));
  fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Next unsent task' } });
  await act(async () => finishQueue());
  expect(screen.getByLabelText('Task prompt')).toHaveValue('Next unsent task');
});

it('explains an empty task-agent catalog and rechecks it without losing the prompt',async()=>{
  let agents=[];
  apiFetch.mockReset().mockImplementation(async url=>({ok:true,json:async()=>url==='/api/agent/catalog'?{agents}:{tasks:[],schedules:[]}}));
  render(<WorkspaceTasksPanel workspacePath={path}/>);
  await screen.findByText(/No compatible task agents/);
  fireEvent.change(screen.getByLabelText('Task prompt'),{target:{value:'Keep unsent prompt'}});
  expect(screen.getByRole('button',{name:'Queue task'})).toBeDisabled();
  agents=[{id:'codex',label:'Codex',available:true,capabilities:{durableTasks:true}}];
  fireEvent.click(screen.getByRole('button',{name:'Recheck task agents'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Queue task'})).toBeEnabled());
  expect(screen.getByLabelText('Task prompt')).toHaveValue('Keep unsent prompt');
});

it('shows stale task polling and clears the recovered read error without losing a draft',async()=>{
 vi.useFakeTimers();
 try{
  apiFetch.mockReset().mockImplementation(async url=>({ok:true,json:async()=>url==='/api/agent/catalog'?{agents:[]}:{tasks:[task],schedules:[]}}));
  await act(async()=>render(<WorkspaceTasksPanel workspacePath={path}/>));
  fireEvent.change(screen.getByLabelText('Task prompt'),{target:{value:'Unsent task'}});
  apiFetch.mockRejectedValueOnce(new Error('Task polling disconnected'));
  await act(async()=>vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole('alert')).toHaveTextContent('Task polling disconnected');
  expect(screen.getByText(/Task list may be out of date/)).toBeInTheDocument();
  expect(screen.getByText('Review finished.')).toBeInTheDocument();
  await act(async()=>vi.advanceTimersByTimeAsync(5000));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Task prompt')).toHaveValue('Unsent task');
 }finally{vi.useRealTimers();}
});

it('creates a one-shot at an explicit UTC instant and shows consumed schedules', async () => {
  apiFetch.mockReset().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/workspace/schedules/capabilities' ? { advancedTimingProtocolVersion: 1 } : url === '/api/agent/catalog'
    ? { agents: [{ id: 'claude', label: 'Claude', available: true, capabilities: { durableTasks: true } }] }
    : { tasks: [], schedules: [{ ...schedule, runOnceAt: 1893456000000, lastTaskId: 'done' }] } }));
  render(<WorkspaceTasksPanel workspacePath={path} />);
  await screen.findByText('No tasks yet.');
  expect(screen.getByText('Triggered')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Enable Morning review' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Review once' } });
  fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Once' } });
  fireEvent.change(screen.getByLabelText('Runs'), { target: { value: 'once' } });
  fireEvent.change(screen.getByLabelText('Date and time (UTC)'), { target: { value: '2035-01-01T00:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules', expect.objectContaining({ body: expect.objectContaining({ runOnceAt: 2051222400000, enabled: false }) })));
});

it('sends the named timezone for recurring calendar schedules', async () => {
  apiFetch.mockReset().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/workspace/schedules/capabilities' ? { advancedTimingProtocolVersion: 1 } : url === '/api/agent/catalog'
    ? { agents: [{ id: 'claude', label: 'Claude', available: true, capabilities: { durableTasks: true } }] }
    : { tasks: [], schedules: [] } }));
  render(<WorkspaceTasksPanel workspacePath={path} />);
  await screen.findByText('No tasks yet.');
  fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Review' } });
  fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Morning' } });
  fireEvent.change(screen.getByLabelText('Runs'), { target: { value: 'calendar' } });
  fireEvent.change(screen.getByLabelText('Time zone (IANA)'), { target: { value: 'America/New_York' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules', expect.objectContaining({ body: expect.objectContaining({ at: { hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5], timeZone: 'America/New_York' } }) })));
});


describe('advanced schedule capability', () => {
  it.each([['once', false], ['once', true], ['calendar', false], ['calendar', true]])('old server rejects a %s submission (enabled: %s) after the capability check', async (timing, enabled) => {
    let checks = 0;
    const received = [];
    apiFetch.mockReset().mockImplementation(async (url, options) => {
      if (url === '/api/workspace/schedules/capabilities') {
        checks += 1;
        return { ok: true, json: async () => ({ advancedTimingProtocolVersion: 1 }) };
      }
      if (url === '/api/agent/catalog') return { ok: true, json: async () => ({ agents: [{ id: 'claude', label: 'Claude', available: true, capabilities: { durableTasks: true } }] }) };
      if (url === '/api/workspace/schedules' && options?.method === 'POST') {
        received.push(options.body);
        // HEAD ignores unknown timing fields and accepts only intervals in this range.
        const accepted = options.body.intervalSeconds >= 60 && options.body.intervalSeconds <= 2_592_000;
        return { ok: accepted, json: async () => ({ error: 'Schedules repeat every 60 seconds to 30 days' }) };
      }
      return { ok: true, json: async () => ({ tasks: [], schedules: [] }) };
    });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Review' } });
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Review' } });
    fireEvent.change(screen.getByLabelText('Runs'), { target: { value: timing } });
    if (timing === 'once') fireEvent.change(screen.getByLabelText('Date and time (UTC)'), { target: { value: '2035-01-01T00:00' } });
    if (enabled) fireEvent.click(screen.getByLabelText('Enable this schedule'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create schedule' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(received).toHaveLength(1));
    expect(checks).toBe(2);
    expect(received[0]).toEqual(expect.objectContaining({ enabled, intervalSeconds: 0, ...(timing === 'once' ? { runOnceAt: 2051222400000 } : { at: expect.any(Object) }) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Schedules repeat every 60 seconds to 30 days');
  });

  it.each([
    ['old server without endpoint', async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })],
    ['unsupported version', async () => ({ ok: true, json: async () => ({ advancedTimingProtocolVersion: 2 }) })],
    ['missing version', async () => ({ ok: true, json: async () => ({}) })],
    ['malformed response', async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } })],
    ['network error', async () => { throw new Error('offline'); }],
  ])('blocks advanced submissions for %s while preserving legacy intervals', async (_label, capability) => {
    const legacyAccepted = [];
    apiFetch.mockReset().mockImplementation(async (url, options) => {
      if (url === '/api/workspace/schedules/capabilities') return capability();
      if (url === '/api/agent/catalog') return { ok: true, json: async () => ({ agents: [{ id: 'claude', label: 'Claude', available: true, capabilities: { durableTasks: true } }] }) };
      if (url === '/api/workspace/schedules' && options?.method === 'POST') {
        // Old server ignores unknown runOnceAt/at fields and accepts intervalSeconds.
        const { name, intervalSeconds, enabled } = options.body;
        legacyAccepted.push({ name, intervalSeconds, enabled });
      }
      return { ok: true, json: async () => ({ tasks: [], schedules: [] }) };
    });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    await screen.findByText(/Advanced scheduling is unavailable/);
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Review' } });
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Review' } });
    for (const timing of ['once', 'calendar']) {
      fireEvent.change(screen.getByLabelText('Runs'), { target: { value: timing } });
      if (timing === 'once') fireEvent.change(screen.getByLabelText('Date and time (UTC)'), { target: { value: '2035-01-01T00:00' } });
      expect(screen.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    }
    expect(legacyAccepted).toEqual([]);
    fireEvent.change(screen.getByLabelText('Runs'), { target: { value: 'interval' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(legacyAccepted).toEqual([{ name: 'Review', intervalSeconds: 3600, enabled: false }]));
  });

  it('rechecks capability before submitting an advanced schedule', async () => {
    let checks = 0;
    apiFetch.mockReset().mockImplementation(async url => {
      if (url === '/api/workspace/schedules/capabilities') return { ok: true, json: async () => ({ advancedTimingProtocolVersion: ++checks === 1 ? 1 : 2 }) };
      if (url === '/api/agent/catalog') return { ok: true, json: async () => ({ agents: [{ id: 'claude', label: 'Claude', available: true, capabilities: { durableTasks: true } }] }) };
      return { ok: true, json: async () => ({ tasks: [], schedules: [] }) };
    });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText('No tasks yet.');
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Review' } });
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Once' } });
    fireEvent.change(screen.getByLabelText('Runs'), { target: { value: 'once' } });
    fireEvent.change(screen.getByLabelText('Date and time (UTC)'), { target: { value: '2035-01-01T00:00' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create schedule' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await screen.findByText(/Advanced scheduling is unavailable/);
    expect(apiFetch.mock.calls.filter(([url, options]) => url === '/api/workspace/schedules' && options?.method === 'POST')).toEqual([]);
  });

  it('shows each schedule\'s last result, last error and missed runs from the task list', async () => {
    const failed = { ...task, id: 'task-bad', status: 'failed', error: 'Agent exited with code 2', result: '', output: '' };
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [failed], schedules: [
      { ...schedule, enabled: true, lastRunAt: 1000, lastTaskId: 'task-bad', missedRuns: 3, lastMissedAt: 2000 },
      { ...schedule, id: 'schedule-two', name: 'Nightly', lastRunAt: 1000, lastTaskId: 'gone' },
      { ...schedule, id: 'schedule-three', name: 'Fresh', missedRuns: 1 },
    ] }) });
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByText(/Last error: Agent exited with code 2/);
    const texts = [...document.querySelectorAll('.workspace-schedule-last, .workspace-schedule-missed')].map(node => node.textContent.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}.*?(?= ·|\)|$)/g, 'DATE'));
    expect(texts).toEqual([
      expect.stringContaining('· failed'),
      expect.stringMatching(/^Missed 3 scheduled runs while the app server was not running \(latest /),
      expect.stringContaining('result unavailable'),
      'Never run',
      expect.stringMatching(/^Missed 1 scheduled run while/),
    ]);
  });
  it.each([true, undefined])('shows no scheduling-unavailable banner and leaves controls enabled when workerAvailable is %s', async workerAvailable => {
    apiFetch.mockReset().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/workspace/schedules/capabilities'
      ? { advancedTimingProtocolVersion: 1, workerAvailable }
      : { tasks: [task], schedules: [schedule] } }));
    render(<WorkspaceTasksPanel workspacePath={path} />);
    await screen.findByRole('button', { name: 'Run Morning review now' });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/schedules/capabilities', expect.anything()));
    expect(screen.queryByText(/Scheduled tasks are unavailable/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Check build' } });
    expect(screen.getByRole('button', { name: 'Queue task' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Run Morning review now' })).toBeEnabled();
  });
  it('shows a persistent banner and disables scheduling controls when the task worker is unavailable', async () => {
    apiFetch.mockReset().mockImplementation(async url => ({ ok: true, json: async () => url === '/api/workspace/schedules/capabilities'
      ? { advancedTimingProtocolVersion: 1, workerAvailable: false, workerReason: 'newer' }
      : { tasks: [task], schedules: [schedule] } }));
    render(<WorkspaceTasksPanel workspacePath={path} />);
    expect(await screen.findByText('Scheduled tasks are unavailable: this data directory was written by a newer version. See the upgrade guide.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Check build' } });
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Review' } });
    expect(['Queue task', 'Create schedule', 'Enable Morning review', 'Run Morning review now'].map(name => screen.getByRole('button', { name }).disabled)).toEqual([true, true, true, true]);
    expect(screen.getByRole('button', { name: 'Remove Morning review' }).disabled).toBe(false);
  });
});
