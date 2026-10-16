import { useCallback, useEffect, useRef, useState } from 'react';
import { clearDownloadCache, downloadChunks, transferRequest, uploadChunks } from '../utils/fileTransfers';
import './FileTransferPanel.css';

export function FileTransferPanel({ workspacePath = '' }) {
 const [records, setRecords] = useState([]);
 const [relativePath, setRelativePath] = useState('');
 const [file, setFile] = useState(null);
 const [busy, setBusy] = useState(null);
 const [error, setError] = useState('');
 const [resumeId, setResumeId] = useState(null);
 const controller = useRef(null);
 const generation = useRef(0);
 const fileInput = useRef(null);
 const update = useCallback(record => setRecords(current => [record, ...current.filter(item => item.id !== record.id)]), []);
 const refresh = useCallback(async () => {
  const current = generation.current;
  try { const rows = await transferRequest('?' + new URLSearchParams({ path: workspacePath }));if (current === generation.current) setRecords(rows); }
  catch (failure) { if (current === generation.current) setError(failure.message); }
 }, [workspacePath]);
 useEffect(() => { generation.current++;setRecords([]);setError('');setBusy(null);setFile(null);setResumeId(null);refresh();return () => { generation.current++;controller.current?.abort(); }; }, [refresh]);
 const run = async action => {
  const current = generation.current;
  const abort = new AbortController();controller.current = abort;setError('');
  try { await action(abort.signal, record => { if (current === generation.current) update(record); }); }
  catch (failure) { if (current === generation.current && failure.name !== 'AbortError') setError(failure.message); }
  finally { if (current === generation.current && controller.current === abort) { setBusy(null);refresh(); } }
 };
 const upload = () => {
  if (!file) return;
  setBusy(resumeId || 'upload');
  run(async (signal, progress) => {
   let record = resumeId ? records.find(item => item.id === resumeId) : await transferRequest('', { method: 'POST', signal, body: { direction: 'upload', workspacePath, relativePath: relativePath || file.name, size: file.size } });
   progress(record);record = await uploadChunks(record, file, { signal, onProgress: progress });progress(record);signal.throwIfAborted();setFile(null);setResumeId(null);
  });
 };
 const download = record => {
  setBusy(record?.id || 'download');
  run(async (signal, progress) => {
   record ||= await transferRequest('/download', { method: 'POST', signal, body: { direction: 'download', workspacePath, relativePath } });
   progress(record);
   const blob = await downloadChunks(record, { signal, onProgress: progress });
   signal.throwIfAborted();const url = URL.createObjectURL(blob);const anchor = document.createElement('a');anchor.href = url;anchor.download = record.relativePath.split('/').pop();anchor.click();setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
 };
 const cancel = record => {
  if (busy === record.id) controller.current?.abort();
  run(async () => { await transferRequest('/' + record.id, { method: 'DELETE' });await clearDownloadCache(record); });
 };
 const chooseResume = record => { setResumeId(record.id);setRelativePath(record.relativePath);setFile(null);fileInput.current?.click(); };
 return <section className="file-transfer-panel" aria-label="File transfers">
  <h3>File transfers</h3>
  <p>Transfer files to or from this workspace. Uploads never replace existing files. Maximum 256 MiB per file.</p>
  {!workspacePath ? <p>Select a workspace first.</p> : <>
   <label>Workspace-relative path<input value={relativePath} onChange={event => setRelativePath(event.target.value)} placeholder="folder/file.txt" disabled={!!busy} /></label>
   <div className="transfer-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault();if (!busy) {setFile(event.dataTransfer.files[0] || null);setResumeId(null);} }}>
    <label>Choose or drop a file<input ref={fileInput} type="file" disabled={!!busy} onChange={event => setFile(event.target.files?.[0] || null)} /></label>
    {file && <span>{file.name} ({file.size.toLocaleString()} bytes)</span>}
   </div>
   {resumeId && <p>Resume {relativePath}: select the original file. Existing bytes are checked before continuing.</p>}
   <div className="transfer-actions"><button disabled={!file || !!busy} onClick={upload}>{resumeId ? 'Resume upload' : 'Upload file'}</button><button disabled={!relativePath || !!busy} onClick={() => download(null)}>Download file</button>{busy && <button onClick={() => controller.current?.abort()}>Pause transfer</button>}<button disabled={!!busy} onClick={refresh}>Refresh transfers</button></div>
   <p className="transfer-note">Uploads resume from server progress after selecting the original file. Downloads retain verified chunks in browser storage when available. Completed downloads are handed to your browser; check its downloads list.</p>
   <ul>{records.map(record => <li key={record.id}>
    <strong>{record.direction === 'upload' ? 'Upload' : 'Download'}: {record.relativePath}</strong><span>{record.status} · {record.offset.toLocaleString()} / {record.size.toLocaleString()} bytes</span>
    <progress aria-label={'Progress for ' + record.relativePath} value={record.offset} max={record.size || 1} />
    <div className="transfer-actions">{record.status === 'pending' && <button disabled={!!busy} onClick={() => record.direction === 'upload' ? chooseResume(record) : download(record)}>Resume {record.direction}</button>}<button disabled={!!busy && busy !== record.id} onClick={() => cancel(record)}>{record.status === 'pending' ? 'Cancel transfer' : 'Remove record'}</button></div>
   </li>)}</ul>
  </>}
  {error && <p role="alert">{error}</p>}
 </section>;
}
