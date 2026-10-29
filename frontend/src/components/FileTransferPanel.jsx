import { useCallback, useEffect, useRef, useState } from 'react';
import { captureDownloadScope, clearDownloadCache, downloadChunks, transferRequest, uploadChunks } from '../utils/fileTransfers';
import './FileTransferPanel.css';

export function FileTransferPanel({ workspacePath = '' }) {
 const [records, setRecords] = useState([]);
 const [relativePath, setRelativePath] = useState('');
 const [file, setFile] = useState(null);
 const [busy, setBusy] = useState(null);
 const [error, setError] = useState('');
 const [resumeId, setResumeId] = useState(null);
 const resumeSelection = useRef(null);
 resumeSelection.current = resumeId;
 const [loading, setLoading] = useState(false);
 const [loaded, setLoaded] = useState(false);
 const controller = useRef(null);
 const generation = useRef(0);
 const fileInput = useRef(null);
 const update = useCallback(record => setRecords(current => [record, ...current.filter(item => item.id !== record.id)]), []);
 const refresh = useCallback(async () => {
  if (!workspacePath) return;
  const current = generation.current;
  setLoading(true);
  try { const rows = await transferRequest('?' + new URLSearchParams({ path: workspacePath }));if (current === generation.current) { setRecords(rows);setLoaded(true); } }
  catch (failure) { if (current === generation.current) setError(failure.message); }
  finally { if (current === generation.current) setLoading(false); }
 }, [workspacePath]);
 useEffect(() => { generation.current++;setRecords([]);setLoaded(false);setLoading(false);setError('');setBusy(null);setFile(null);setResumeId(null);refresh();return () => { generation.current++;controller.current?.abort(); }; }, [refresh]);
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
  const cacheScope = captureDownloadScope();
  const version = generation.current;
  if (busy === record.id) controller.current?.abort();
  run(async () => { await transferRequest('/' + record.id, { method: 'DELETE' });await clearDownloadCache(record, cacheScope);if (version === generation.current && record.id === resumeSelection.current) { setResumeId(null);setFile(null);setRelativePath('');if (fileInput.current) fileInput.current.value = ''; } });
 };
 const chooseResume = record => { setResumeId(record.id);setRelativePath(record.relativePath);setFile(null);fileInput.current?.click(); };
 return <section className="file-transfer-panel" aria-label="File transfers">
  <header><h3>File transfers</h3>
  <p>Transfer files to or from this workspace. Uploads never replace existing files. Maximum 256 MiB per file.</p></header>
  {!workspacePath ? <p>Select a workspace first.</p> : <>
   <label>Workspace-relative path<input value={relativePath} onChange={event => setRelativePath(event.target.value)} placeholder="folder/file.txt" disabled={!!busy || !!resumeId} /></label>
   <div className="transfer-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault();if (!busy) {setFile(event.dataTransfer.files[0] || null);setResumeId(null);} }}>
    <label>Choose or drop a file<input ref={fileInput} type="file" disabled={!!busy} onChange={event => setFile(event.target.files?.[0] || null)} /></label>
    {file && <span>{file.name} ({file.size.toLocaleString()} bytes)</span>}
   </div>
   {resumeId && <div><p>Resume {relativePath}: select the original file. Existing bytes are checked before continuing.</p><button type="button" disabled={!!busy} onClick={() => { setResumeId(null); setFile(null); setRelativePath(''); if (fileInput.current) fileInput.current.value = ''; }}>Cancel resume</button></div>}
   <div className="transfer-actions"><button disabled={!file || !!busy} onClick={upload}>{resumeId ? 'Resume upload' : 'Upload file'}</button><button disabled={!relativePath || !!busy} onClick={() => download(null)}>Download file</button>{busy && <button onClick={() => controller.current?.abort()}>Pause transfer</button>}<button disabled={!!busy || loading} onClick={() => { setError('');refresh(); }}>Refresh transfers</button></div>
   <p className="transfer-note">Uploads resume from server progress after selecting the original file. Downloads retain verified chunks in browser storage when available. Completed downloads can be saved again until you remove the record. Their snapshots count toward the storage quota.</p>
   {loading && <p role="status">Loading transfers…</p>}
   {loaded && !loading && !error && records.length === 0 && <p>No transfers in this workspace.</p>}
   <ul aria-label="Workspace transfers" aria-busy={loading}>{records.map(record => <li key={record.id}>
    <strong>{record.direction === 'upload' ? 'Upload' : 'Download'}: {record.relativePath}</strong><span>{record.status} · {record.offset.toLocaleString()} / {record.size.toLocaleString()} bytes</span>
    <progress aria-label={'Progress for ' + record.relativePath} value={record.offset} max={record.size || 1} />
    <div className="transfer-actions">{record.status === 'pending' && <button disabled={!!busy} onClick={() => record.direction === 'upload' ? chooseResume(record) : download(record)}>Resume {record.direction}</button>}{record.status === 'completed' && record.direction === 'download' && <button disabled={!!busy} onClick={() => download(record)}>Save download</button>}<button disabled={!!busy && busy !== record.id} onClick={() => cancel(record)}>{record.status === 'pending' ? 'Cancel transfer' : 'Remove record'}</button></div>
   </li>)}</ul>
  </>}
  {error && <p role="alert">{error}</p>}
 </section>;
}
