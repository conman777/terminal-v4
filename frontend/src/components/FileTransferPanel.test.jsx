import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('../utils/fileTransfers', () => ({ transferRequest: vi.fn(), uploadChunks: vi.fn(), downloadChunks: vi.fn(), clearDownloadCache: vi.fn() }));
import { transferRequest, uploadChunks } from '../utils/fileTransfers';
import { FileTransferPanel } from './FileTransferPanel';
describe('FileTransferPanel', () => {
 beforeEach(() => { vi.clearAllMocks();transferRequest.mockResolvedValue([]); });
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

});
