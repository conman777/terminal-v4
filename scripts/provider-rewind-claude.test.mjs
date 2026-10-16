import test from 'node:test';
import assert from 'node:assert/strict';
import { forkClaude } from './provider-rewind-claude.mjs';
const sessionId='00000000-0000-4000-8000-000000000001';
const cursor='00000000-0000-4000-8000-000000000002';
const branch='00000000-0000-4000-8000-000000000003';
test('Claude branch invokes native SDK at exact prior message without model query', async () => {
 const calls=[];
 const result=await forkClaude({sessionId,workspace:process.cwd(),cursor}, async (...args)=>{calls.push(args);return {sessionId:branch};});
 assert.deepEqual({result,calls},{result:{sessionId:branch},calls:[[sessionId,{dir:process.cwd(),upToMessageId:cursor,title:'Terminal v4 rewind'}]]});
});
test('Claude branch rejects unknown fields, missing cursor, and same native ID', async ()=> {
 for(const input of [{sessionId,workspace:process.cwd()},{sessionId,workspace:process.cwd(),cursor,query:'execute'}]) await assert.rejects(forkClaude(input,()=>{throw new Error('must not call SDK')}));
 await assert.rejects(forkClaude({sessionId,workspace:process.cwd(),cursor}, async()=>({sessionId})));
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('real SDK forks persisted native transcript at a prior assistant message while source is unchanged', async ()=> {
 const directory=await mkdtemp(join(tmpdir(),'terminal-v4-claude-rewind-'));
 try {
  const workspace=join(directory,'workspace');await mkdir(workspace);
  const home=join(directory,'claude');const project=join(home,'projects',workspace.replace(/[^a-zA-Z0-9]/g,'-'));await mkdir(project,{recursive:true});
  const second='00000000-0000-4000-8000-000000000004';
  const records=[
   {type:'user',uuid:sessionId,parentUuid:null,message:{role:'user',content:'first'}},
   {type:'assistant',uuid:cursor,parentUuid:sessionId,message:{role:'assistant',content:[{type:'text',text:'reply'}]}},
   {type:'user',uuid:second,parentUuid:cursor,message:{role:'user',content:'second'}},
  ].map(row=>({...row,sessionId,cwd:workspace,isSidechain:false,timestamp:'2026-01-01T00:00:00Z'}));
  const original=records.map(JSON.stringify).join('\n')+'\n';const source=join(project,sessionId+'.jsonl');await writeFile(source,original);
  const {stdout}=await promisify(execFile)(process.execPath,['scripts/provider-rewind-claude.mjs',JSON.stringify({sessionId,workspace,cursor})],{cwd:process.cwd(),env:{...process.env,CLAUDE_CONFIG_DIR:home},timeout:10000});
  const result=JSON.parse(stdout);assert.notEqual(result.sessionId,sessionId);
  const native=(await readFile(join(project,result.sessionId+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(native.filter(row=>['user','assistant'].includes(row.type)).map(row=>row.message.content),['first',[{type:'text',text:'reply'}]]);
  assert.equal(await readFile(source,'utf8'),original);
 } finally {await rm(directory,{recursive:true,force:true});}
});
