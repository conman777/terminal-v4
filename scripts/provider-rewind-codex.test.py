import json, os, queue, subprocess, tempfile, threading, uuid, sys
from pathlib import Path
if os.name != "nt":
 print("SKIP: installed Codex native fixture currently verifies Windows npm layout")
 sys.exit(0)
base = Path(os.environ["APPDATA"]) / "npm" / "node_modules" / "@openai" / "codex"
binaries = list((base / "node_modules" / "@openai").glob("codex-win32-*/vendor/*/bin/codex.exe")) if (base / "node_modules" / "@openai").exists() else []
if not binaries:
 print("SKIP: install Codex native runtime to verify provider fork fixture")
 sys.exit(0)
with tempfile.TemporaryDirectory(prefix='terminal-v4-codex-rewind-') as temporary:
 root=Path(temporary);workspace=root/'workspace';workspace.mkdir();home=root/'codex';sessions=home/'sessions'/'2026'/'01'/'01';sessions.mkdir(parents=True)
 session=str(uuid.uuid4()); turn1=str(uuid.uuid4());turn2=str(uuid.uuid4())
 timestamp='2026-01-01T00:00:00.000Z'
 def event(kind,payload):return {'timestamp':timestamp,'type':kind,'payload':payload}
 rows=[event('session_meta',{'id':session,'timestamp':timestamp,'cwd':str(workspace),'originator':'codex_cli_rs','cli_version':'0.115.0','source':'cli','model_provider':'openai'})]
 for turn,prompt,reply in [(turn1,'first marker','first reply'),(turn2,'second marker','second reply')]:
  rows.extend([event('event_msg',{'type':'task_started','turn_id':turn,'model_context_window':200000}),event('turn_context',{'turn_id':turn,'cwd':str(workspace),'approval_policy':'on-request','sandbox_policy':{'type':'workspace-write'},'model':'test','effort':'low','summary':'auto'}),event('response_item',{'type':'message','role':'user','content':[{'type':'input_text','text':prompt}]}),event('event_msg',{'type':'user_message','message':prompt,'images':[],'local_images':[],'text_elements':[]}),event('response_item',{'type':'message','role':'assistant','content':[{'type':'output_text','text':reply}]}),event('event_msg',{'type':'agent_message','message':reply}),event('event_msg',{'type':'task_complete','turn_id':turn,'last_agent_message':reply})])
 source=sessions/f'rollout-2026-01-01T00-00-00-{session}.jsonl';source.write_text(''.join(json.dumps(row)+'\n' for row in rows),encoding='utf-8');original=source.read_bytes()
 binary=Path(os.environ['APPDATA'])/'npm'/'node_modules'/'@openai'/'codex'/'bin'/'codex.js'
 process=subprocess.Popen([str(binaries[0]),'app-server','--listen','stdio://'],cwd=workspace,env={**os.environ,'CODEX_HOME':str(home)},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8')
 frames=queue.Queue()
 def read():
  for line in process.stdout: frames.put(json.loads(line))
 threading.Thread(target=read,daemon=True).start();sequence=0
 def request(method,params):
  global sequence
  sequence+=1;identity=sequence;process.stdin.write(json.dumps({'id':identity,'method':method,'params':params})+'\n');process.stdin.flush()
  while True:
   value=frames.get(timeout=15)
   if value.get('id')==identity:
    if 'error' in value:raise RuntimeError(method+': '+json.dumps(value['error']))
    return value['result']
 try:
  request('initialize',{'clientInfo':{'name':'terminal-v4-native-rewind-smoke','version':'1.0.0'},'capabilities':{'experimentalApi':True,'explicitGatewayOauth':True}})
  process.stdin.write('{"method":"initialized"}\n');process.stdin.flush()
  metadata=request('thread/read',{'threadId':session,'includeTurns':True})
  turns=request('thread/turns/list',{'threadId':session,'limit':100,'sortDirection':'asc','itemsView':'full'})
  print('Original native turn count:',len(turns['data']))
  fork=request('thread/fork',{'threadId':session,'lastTurnId':turn1,'cwd':str(workspace),'sandbox':'workspace-write','approvalPolicy':'on-request'})
  branch=fork['thread']['id'];prefix=request('thread/turns/list',{'threadId':branch,'limit':100,'sortDirection':'asc','itemsView':'full'})
  print('Fork native turn count:',len(prefix['data']))
  assert len(prefix['data'])==1
  try:
   request('thread/revert',{'threadId':branch,'beforeTurnId':prefix['data'][0]['id']})
  except RuntimeError as error:
   assert 'only supports paginated' in str(error)
   print('Legacy first-turn revert correctly unavailable')
  assert source.read_bytes()==original
  print('Native prefix fork succeeds; first-turn capability accurately rejected; source unchanged')
 finally:
  subprocess.run([str(Path(os.environ['SystemRoot'])/'System32'/'taskkill.exe'),'/T','/F','/PID',str(process.pid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);process.wait(timeout=5)
  process.stdin.close();process.stdout.close()
