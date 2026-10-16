import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceGitPanel } from './WorkspaceGitPanel';
const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
const path = '/projects/example';
const tree = { id: 'tree', name: 'Fix example', path: '/tasks/example', branch: 'codex/fix-example', available: true };
const reply = data => ({ ok: true, json: async () => data });
describe('WorkspaceGitPanel', () => {
  beforeEach(() => {
    apiFetch.mockReset(); apiFetch.mockImplementation(async url => {
      if (url.includes('/worktrees') || url.includes('/checkpoints')) return reply([]);
      if (url.includes('/diff')) return reply({ patch: '+<script>unsafe()</script>', binary: false, truncated: false });
      return reply({ branch: 'feature', files: [{path: 'src/example.js', status:' M', added:2, removed:1}], truncated:false });
    });
  });
  it('reviews escaped diff text and staged changes', async () => {
    render(<WorkspaceGitPanel workspacePath={path} />);
    fireEvent.click(await screen.findByRole('button',{name:/src\/example.js/}));
    expect(await screen.findByText('+<script>unsafe()</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.change(screen.getByLabelText('Review changes'),{target:{value:'staged'}});
    await waitFor(()=>expect(apiFetch.mock.calls.some(([url])=>url.includes('mode=staged'))).toBe(true));
  });
  it('creates and starts an isolated task in the returned directory', async () => {
    const onStartTask=vi.fn(); apiFetch.mockImplementation(async (url,options)=>options?.method==='POST'?reply(tree):reply(url.includes('/status')?{branch:'main',files:[]}:[]));
    render(<WorkspaceGitPanel workspacePath={path} onStartTask={onStartTask} />);
    await screen.findByText('No changed files in this view.');
    fireEvent.change(screen.getByLabelText('Task name'),{target:{value:'Fix example'}});
    fireEvent.click(screen.getByRole('button',{name:'Create isolated task'}));
    fireEvent.click(await screen.findByRole('button',{name:'Start Fix example'}));
    expect(onStartTask).toHaveBeenCalledWith(tree.path);
    expect(apiFetch.mock.calls.find(([,options])=>options?.method==='POST')).toEqual(['/api/workspace/git/worktrees',{method:'POST',body:{path,name:'Fix example',baseRef:'HEAD'}}]);
  });
  it('shows binary and truncation limitations', async () => {
    apiFetch.mockImplementation(async url=>url.includes('/worktrees')||url.includes('/checkpoints')?reply([]):url.includes('/diff')?reply({patch:'',binary:true,truncated:true}):reply({branch:'main',files:[{path:'binary.bin'}]}));
    render(<WorkspaceGitPanel workspacePath={path} />);fireEvent.click(await screen.findByRole('button',{name:/binary.bin/}));
    expect(await screen.findByText('Binary file: text diff unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Diff exceeds the preview limit. Review the full file locally.')).toBeInTheDocument();
  });
  it('captures a checkpoint and requires explicit file-restore confirmation', async () => {
    const checkpoint={id:'checkpoint',label:'Before edits',createdAt:1};
    apiFetch.mockImplementation(async (url,options)=>options?.method==='POST'?reply(checkpoint):reply(url.includes('/status')?{branch:'main',files:[],managed:true}:[]));
    render(<WorkspaceGitPanel workspacePath={path}/>);await screen.findByText('No changed files in this view.');
    fireEvent.change(screen.getByLabelText('Checkpoint label'),{target:{value:'Before edits'}});
    fireEvent.click(screen.getByRole('button',{name:'Save checkpoint'}));
    fireEvent.click(await screen.findByRole('button',{name:'Restore Before edits'}));
    expect(screen.getByText(/Restoring files does not rewind the agent conversation/)).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([url])=>url.includes('/restore'))).toEqual([]);
    fireEvent.click(screen.getByRole('button',{name:'Restore files'}));
    await waitFor(()=>expect(apiFetch.mock.calls.some(([url])=>url.includes('/restore'))).toBe(true));
  });
  it('archives a checkout without starting it and reactivates the retained task', async () => {
    let currentTree = {...tree, archived:false};
    const onStartTask = vi.fn();
    apiFetch.mockImplementation(async (url,options) => {
      if (url.endsWith('/archive')) { currentTree = {...currentTree,archived:true}; return reply(currentTree); }
      if (url.endsWith('/reactivate')) { currentTree = {...currentTree,archived:false}; return reply(currentTree); }
      return reply(url.includes('/worktrees') ? [currentTree] : url.includes('/status') ? {branch:'main',files:[]} : []);
    });
    render(<WorkspaceGitPanel workspacePath={path} onStartTask={onStartTask} />);
    fireEvent.click(await screen.findByRole('button',{name:'Archive Fix example'}));
    await screen.findByRole('button',{name:'Reactivate Fix example'});
    expect(screen.queryByRole('button',{name:'Start Fix example'})).not.toBeInTheDocument();
    expect(onStartTask).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls.find(([url])=>url.endsWith('/archive'))).toEqual([
      '/api/workspace/git/worktrees/archive',{method:'POST',body:{path,worktreeId:tree.id}}
    ]);
    fireEvent.click(screen.getByRole('button',{name:'Reactivate Fix example'}));
    expect(await screen.findByRole('button',{name:'Start Fix example'})).toBeEnabled();
  });
  it('reports creation failure without starting a task', async () => {
    apiFetch.mockImplementation(async (url,options)=>options?.method==='POST'?{ok:false,json:async()=>({error:'Base does not exist'})}:reply(url.includes('/status')?{branch:'main',files:[]}:[]));
    render(<WorkspaceGitPanel workspacePath={path}/>);await screen.findByText('No changed files in this view.');
    fireEvent.change(screen.getByLabelText('Task name'),{target:{value:'Fix'}});fireEvent.click(screen.getByRole('button',{name:'Create isolated task'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Base does not exist');
  });
});
