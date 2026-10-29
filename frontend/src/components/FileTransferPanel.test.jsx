import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('../utils/fileTransfers', () => ({ transferRequest: vi.fn(), uploadChunks: vi.fn(), downloadChunks: vi.fn(), clearDownloadCache: vi.fn(), captureDownloadScope: vi.fn() }));
import { transferRequest, uploadChunks, downloadChunks } from '../utils/fileTransfers';
import { FileTransferPanel } from './FileTransferPanel';
describe('FileTransferPanel', () => {
 beforeEach(() => { vi.clearAllMocks();transferRequest.mockResolvedValue([]); });
 it('distinguishes loading transfers from an empty workspace', async () => {
  let finish;
  transferRequest.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<FileTransferPanel workspacePath="/work" />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading transfers');
  expect(screen.queryByText('No transfers in this workspace.')).not.toBeInTheDocument();
  await act(async () => finish([]));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByText('No transfers in this workspace.')).toBeInTheDocument();
 });
 it('requires a workspace before offering upload', () => { render(<FileTransferPanel />);expect(screen.getByText('Select a workspace first.')).toBeInTheDocument();expect(screen.queryByRole('button', { name: 'Upload file' })).not.toBeInTheDocument(); });
 it('loads pending records and requires original file to resume', async () => {
  transferRequest.mockResolvedValue([{ id: 'pending', direction: 'upload', relativePath: 'new.txt', size: 5, offset: 3, status: 'pending' }]);render(<FileTransferPanel workspacePath="/work" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume upload' }));expect(screen.getByText(/select the original file/i)).toBeInTheDocument();expect(uploadChunks).not.toHaveBeenCalled();
 });
 it('starts actual chunk upload and displays server errors', async () => {
  transferRequest.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 'new', size: 5, offset: 0, direction: 'upload', relativePath: 'new.txt', status: 'pending' }).mockResolvedValue([]);uploadChunks.mockRejectedValue(new Error('Chunk checksum mismatch'));
  render(<FileTransferPanel workspacePath="/work" />);await waitFor(() => expect(transferRequest).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Choose or drop a file'), { target: { files: [new File(['hello'], 'new.txt')] } });fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));expect(await screen.findByRole('alert')).toHaveTextContent('Chunk checksum mismatch');expect(uploadChunks).toHaveBeenCalled();
 });
 it('preserves a new workspace file selection when an older upload finishes', async () => {
  let finish;
  const pending={id:'old',direction:'upload',relativePath:'old.txt',size:3,offset:0,status:'pending'};
  transferRequest.mockImplementation(async (_path,options)=>options?.method==='POST'?pending:[]);
  uploadChunks.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const {rerender}=render(<FileTransferPanel workspacePath="/old" />);
  fireEvent.change(screen.getByLabelText('Choose or drop a file'),{target:{files:[new File(['old'],'old.txt')]}});
  fireEvent.click(screen.getByRole('button',{name:'Upload file'}));
  await waitFor(()=>expect(uploadChunks).toHaveBeenCalled());
  rerender(<FileTransferPanel workspacePath="/new" />);
  fireEvent.change(screen.getByLabelText('Choose or drop a file'),{target:{files:[new File(['new'],'new.txt')]}});
  await act(async()=>finish({...pending,status:'completed'}));
  expect(screen.getByText('new.txt (3 bytes)')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Upload file'})).toBeEnabled();
 });

 it('offers browser delivery again for a completed download', async () => {
  transferRequest.mockResolvedValue([{ id: 'completed', direction: 'download', relativePath: 'saved.txt', size: 2, offset: 2, status: 'completed' }]);
  downloadChunks.mockRejectedValue(new Error('synthetic delivery check'));
  render(<FileTransferPanel workspacePath="/work" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save download' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('synthetic delivery check');
 });

});

it('exits resume mode after cancelling a picker so a normal file starts a new transfer',async()=>{
 transferRequest.mockReset().mockResolvedValue([{id:'old-pending',direction:'upload',relativePath:'old.txt',size:3,offset:1,status:'pending'}]);
 uploadChunks.mockReset().mockRejectedValue(new Error('Synthetic stop'));
 render(<FileTransferPanel workspacePath="/work"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Resume upload'}));
 fireEvent.click(screen.getByRole('button',{name:'Cancel resume'}));
 expect(screen.getByLabelText('Workspace-relative path')).toHaveValue('');
 fireEvent.change(screen.getByLabelText('Choose or drop a file'),{target:{files:[new File(['new'],'new.txt')]}});
 expect(screen.getByRole('button',{name:'Upload file'})).toBeEnabled();
 transferRequest.mockResolvedValueOnce({id:'new-transfer',direction:'upload',relativePath:'new.txt',size:3,offset:0,status:'pending'});
 fireEvent.click(screen.getByRole('button',{name:'Upload file'}));
 await waitFor(()=>expect(transferRequest).toHaveBeenCalledWith('',expect.objectContaining({method:'POST',body:{direction:'upload',workspacePath:'/work',relativePath:'new.txt',size:3}})));
});

it('makes the saved resume destination read-only and exits resume after removing its record',async()=>{
 transferRequest.mockReset().mockResolvedValue([{id:'selected-resume',direction:'upload',relativePath:'saved.txt',size:3,offset:1,status:'pending'}]);
 render(<FileTransferPanel workspacePath="/work"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Resume upload'}));
 expect(screen.getByLabelText('Workspace-relative path')).toBeDisabled();
 expect(screen.getByLabelText('Workspace-relative path')).toHaveValue('saved.txt');
 transferRequest.mockResolvedValue([]);
 fireEvent.click(screen.getByRole('button',{name:'Cancel transfer'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Cancel resume'})).not.toBeInTheDocument());
 expect(screen.getByRole('button',{name:'Upload file'})).toBeDisabled();
 expect(screen.getByLabelText('Workspace-relative path')).toHaveValue('');
 expect(screen.getByLabelText('Workspace-relative path')).toBeEnabled();
});

it('preserves a newer resume selection when an older record removal completes',async()=>{
 const rows=[{id:'resume-a',direction:'upload',relativePath:'a.txt',size:3,offset:1,status:'pending'},{id:'resume-b',direction:'upload',relativePath:'b.txt',size:3,offset:1,status:'pending'}];
 let finish;
 transferRequest.mockReset().mockImplementation((_path,options)=>options?.method==='DELETE'?new Promise(resolve=>{finish=()=>resolve({});}):Promise.resolve(rows));
 render(<FileTransferPanel workspacePath="/work"/>);
 const resumes=await screen.findAllByRole('button',{name:'Resume upload'});
 fireEvent.click(resumes[0]);fireEvent.click(screen.getAllByRole('button',{name:'Cancel transfer'})[0]);fireEvent.click(resumes[1]);
 fireEvent.change(screen.getByLabelText('Choose or drop a file'),{target:{files:[new File(['bbb'],'b.txt')]}});
 expect(screen.getByLabelText('Workspace-relative path')).toHaveValue('b.txt');
 await act(async()=>finish());
 expect(screen.getByLabelText('Workspace-relative path')).toHaveValue('b.txt');
 expect(screen.getByRole('button',{name:'Cancel resume'})).toBeInTheDocument();
 expect(screen.getByText('b.txt (3 bytes)')).toBeInTheDocument();
});

it('does not reset a resumed file in a newer workspace when an older cancellation completes',async()=>{
 const record={id:'same-synthetic-id',direction:'upload',relativePath:'original.txt',size:3,offset:1,status:'pending'};
 let finish;
 transferRequest.mockReset().mockImplementation((_path,options)=>options?.method==='DELETE'?new Promise(resolve=>{finish=()=>resolve({});}):Promise.resolve([record]));
 const view=render(<FileTransferPanel workspacePath="/old"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Resume upload'}));fireEvent.click(screen.getByRole('button',{name:'Cancel transfer'}));
 view.rerender(<FileTransferPanel workspacePath="/new"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Resume upload'}));
 fireEvent.change(screen.getByLabelText('Choose or drop a file'),{target:{files:[new File(['new'],'new-original.txt')]}});
 await act(async()=>finish());
 expect(screen.getByText('new-original.txt (3 bytes)')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Cancel resume'})).toBeInTheDocument();
});
