import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileManager } from './FileManager';
import { apiFetch, apiGet } from '../utils/api';

vi.mock('../utils/api', () => ({ apiGet: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../utils/auth', async importOriginal => ({ ...await importOriginal(), getAccessToken: () => null }));

const workspace = '/synthetic/workspace';
const archive = { name: 'fixture.zip', type: 'file', size: 0 };
const rejected = (message) => ({ ok: false, json: async () => ({ error: message }) });

async function openFiles() {
  const view = render(<FileManager isOpen initialPath={workspace} onClose={() => {}} />);
  await screen.findByText(archive.name);
  return view;
}

async function enterFolderDraft() {
  fireEvent.click(screen.getByTitle('New folder'));
  fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'keep-this-draft' } });
  fireEvent.click(screen.getByText('Create'));
}

describe('FileManager operation outcomes', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue({ path: workspace, items: [archive] });
    apiFetch.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('retains the folder draft and reports an HTTP rejection, then clears the draft after a successful retry', async () => {
    apiFetch.mockResolvedValueOnce(rejected('Folder already exists')).mockResolvedValueOnce({ ok: true });
    await openFiles();
    await enterFolderDraft();
    await screen.findByText('Folder already exists');
    expect(screen.getByPlaceholderText('Folder name')).toHaveValue('keep-this-draft');
    expect(apiGet).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(screen.queryByPlaceholderText('Folder name')).not.toBeInTheDocument());
    expect(screen.queryByText('Folder already exists')).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenLastCalledWith('/api/files/mkdir', { method: 'POST', body: { path: `${workspace}/keep-this-draft` } });
  });

  it.each([
    ['Delete', '/api/files/delete', 'DELETE', { path: `${workspace}/${archive.name}` }],
    ['Extract', '/api/files/unzip', 'POST', { zipPath: `${workspace}/${archive.name}` }],
  ])('reports rejected %s without a success refresh, and refreshes after a successful retry', async (title, endpoint, method, body) => {
    apiFetch.mockResolvedValueOnce(rejected('Access denied')).mockResolvedValueOnce({ ok: true });
    await openFiles();
    if (title === 'Delete') fireEvent.click(screen.getByRole('button', { name: 'More actions for ' + archive.name }));
    fireEvent.click(title === 'Delete' ? screen.getByRole('menuitem', { name: 'Delete' }) : screen.getByTitle(title));
    await screen.findByText('Access denied');
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(screen.getByText(archive.name)).toBeInTheDocument();
    if (title === 'Delete') fireEvent.click(screen.getByRole('button', { name: 'More actions for ' + archive.name }));
    fireEvent.click(title === 'Delete' ? screen.getByRole('menuitem', { name: 'Delete' }) : screen.getByTitle(title));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenLastCalledWith(endpoint, { method, body });
  });

  it('reports non-JSON HTTP errors and thrown transport errors without discarding the folder draft', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => { throw new Error('HTML response'); } })
      .mockRejectedValueOnce(new Error('Network unavailable'));
    await openFiles();
    await enterFolderDraft();
    await screen.findByText('Failed to create folder');
    fireEvent.click(screen.getByText('Create'));
    await screen.findByText('Network unavailable');
    expect(screen.getByPlaceholderText('Folder name')).toHaveValue('keep-this-draft');
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('refreshes an upload batch and distinguishes all-success from all-failed (accepted: %s)', async (accepted) => {
    apiFetch.mockResolvedValue(accepted ? { ok: true } : { ok: false, json: async () => ({ message: 'Quota reached' }) });
    const view = await openFiles();
    fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [new File(['fixture'], 'one.txt')] } });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument();
    if (accepted) {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole('alert')).toHaveTextContent('0/1 files uploaded. Failed to upload one.txt: Quota reached');
    }
  });

  it('keeps every failed upload visible after refreshing successful files, including a subsequent refresh failure', async () => {
    const uploaded = { name: 'uploaded.txt', type: 'file', size: 7 };
    apiFetch.mockResolvedValueOnce(rejected('First denied')).mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('Last disconnected'));
    apiGet.mockResolvedValueOnce({ path: workspace, items: [archive] })
      .mockResolvedValueOnce({ path: workspace, items: [archive, uploaded] })
      .mockRejectedValueOnce(new Error('Listing unavailable'));
    const view = await openFiles();
    const files = ['first.txt', uploaded.name, 'last.txt'].map(name => new File(['fixture'], name));
    fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files } });
    await screen.findByText(uploaded.name);
    const error = view.container.querySelector('.file-manager-error');
    expect(error).toHaveTextContent('1/3 files uploaded');
    expect(error).toHaveTextContent('Failed to upload first.txt: First denied');
    expect(error).toHaveTextContent('Failed to upload last.txt: Last disconnected');
    expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => expect(error).toHaveTextContent('Listing unavailable'));
    expect(error).toHaveTextContent('Failed to upload first.txt: First denied');
    expect(error).toHaveTextContent('Failed to upload last.txt: Last disconnected');
  });
});

it.each(['Delete', 'Extract', 'Create', 'Upload'])('keeps the browsed folder when an earlier %s completes', async action => {
  let finish;
  apiFetch.mockReset().mockImplementation(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
  apiGet.mockReset().mockImplementation(async url => {
    const path = new URL(url, 'http://fixture.invalid').searchParams.get('path');
    return { path, items: path === workspace ? [archive, { name: 'nested', type: 'directory' }] : [{ name: 'nested-marker', type: 'file' }] };
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const view = await openFiles();
  if (action === 'Create') await enterFolderDraft();
  else if (action === 'Upload') fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [new File(['synthetic'], 'one.txt')] } });
  else {
    if (action === 'Delete') fireEvent.click(screen.getByRole('button', { name: 'More actions for ' + archive.name }));
    fireEvent.click(action === 'Delete' ? screen.getByRole('menuitem', { name: 'Delete' }) : screen.getByRole('button', { name: action + ' ' + archive.name, exact: true }));
  }
  fireEvent.click(screen.getByRole('button', { name: 'Open folder nested' }));
  await screen.findByText('nested-marker');
  await act(async () => finish());
  expect(screen.getByText('nested-marker')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: 'File path' }).querySelector('[aria-current="location"]')).toHaveTextContent('nested');
});

it('does not upload a delayed drop into a folder the user has left', async () => {
  let enumerate;
  apiGet.mockReset().mockImplementation(async url => { const path=new URL(url,'http://fixture.invalid').searchParams.get('path');return {path,items:[archive,{name:'nested',type:'directory'}]}; });
  apiFetch.mockReset().mockResolvedValue({ok:true});
  const view=await openFiles();
  fireEvent.drop(view.container.querySelector('.file-manager-list'),{dataTransfer:{items:[{webkitGetAsEntry:()=>({isFile:true,file:resolve=>{enumerate=resolve;}})}],files:[]}});
  fireEvent.click(screen.getByRole('button',{name:'Open folder nested'}));
  await waitFor(()=>expect(screen.getByRole('navigation',{name:'File path'}).querySelector('[aria-current="location"]')).toHaveTextContent('nested'));
  await act(async()=>enumerate(new File(['fixture'],'delayed.txt')));
  expect(apiFetch).not.toHaveBeenCalled();
  expect(screen.getByRole('navigation',{name:'File path'}).querySelector('[aria-current="location"]')).toHaveTextContent('nested');
});

it('disables new operations while a folder navigation is unresolved', async()=>{
  let finish;
  apiGet.mockReset().mockResolvedValueOnce({path:workspace,items:[{name:'nested',type:'directory'}]}).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  render(<FileManager isOpen initialPath={workspace} onClose={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Open folder nested'}));
  expect(screen.getByRole('button',{name:'Upload',exact:true})).toBeDisabled();
  expect(screen.getByRole('button',{name:'New folder',exact:true})).toBeDisabled();
  await act(async()=>finish({path:workspace+'/nested',items:[]}));
});

it('preserves a newer folder draft when an earlier mkdir finishes',async()=>{
  let finish;
  apiGet.mockReset().mockResolvedValue({path:workspace,items:[archive]});
  apiFetch.mockReset().mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({ok:true});}));
  await openFiles();await enterFolderDraft();
  fireEvent.keyDown(screen.getByLabelText('Folder name'),{key:'Escape'});
  fireEvent.click(screen.getByRole('button',{name:'New folder',exact:true}));
  fireEvent.change(screen.getByLabelText('Folder name'),{target:{value:'Next unsent folder'}});
  await act(async()=>finish());
  expect(screen.getByLabelText('Folder name')).toHaveValue('Next unsent folder');
});
