import React from 'react';
import {act,render,fireEvent,screen,waitFor} from '@testing-library/react';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
const api=vi.hoisted(()=>({get:vi.fn(),fetch:vi.fn()}));
vi.mock('../utils/api.js',()=>({apiGet:api.get,apiFetch:api.fetch}));
vi.mock('./AudioWaveform.jsx',()=>({AudioWaveform:()=>null}));
import {setTokens,setUser,clearTokens} from '../utils/auth.js';
import {TerminalMicButton} from './TerminalMicButton.jsx';
let stopTrack,transcription,inputs;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
class Recorder {
 static isTypeSupported(){return true;}
 constructor(){this.state='inactive';}
 start(){this.state='recording';}
 stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['s'.repeat(256)])});this.onstop?.();}
}
beforeEach(()=>{
 setTokens('synthetic-access','synthetic-refresh');setUser({id:'synthetic-owner-a'});
 stopTrack=vi.fn();transcription=deferred();inputs=[];
 vi.stubGlobal('MediaRecorder',Recorder);
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[{stop:stopTrack}]})}});
 api.get.mockReset().mockResolvedValue({available:true});
 api.fetch.mockReset().mockImplementation((url,options)=>{
  if(url.startsWith('/api/transcribe'))return transcription.promise;
  inputs.push({url,body:options.body});return Promise.resolve({ok:true});
 });
});
afterEach(()=>{vi.unstubAllGlobals();clearTokens(true);});
it('retained mic session change disposes active same-provider recording',async()=>{
 const view=render(<TerminalMicButton sessionId="synthetic-a" provider="local"/>);
 fireEvent.click(screen.getByLabelText('Voice input (local Whisper)'));
 await screen.findByLabelText('Stop recording');
 view.rerender(<TerminalMicButton sessionId="synthetic-b" provider="local"/>);
 expect({stops:stopTrack.mock.calls.length,stopButton:screen.queryByLabelText('Stop recording')!==null}).toEqual({stops:1,stopButton:false});
});
it('retained mic session change fences late upload from its old terminal target',async()=>{
 const view=render(<TerminalMicButton sessionId="synthetic-a" provider="local"/>);
 fireEvent.click(screen.getByLabelText('Voice input (local Whisper)'));
 fireEvent.click(await screen.findByLabelText('Stop recording'));
 await waitFor(()=>expect(api.fetch).toHaveBeenCalledTimes(1));
 const signal=api.fetch.mock.calls[0][1].signal;
 view.rerender(<TerminalMicButton sessionId="synthetic-b" provider="local"/>);
 await act(async()=>transcription.resolve({ok:true,json:async()=>({text:'synthetic stale transcript'})}));
 expect({aborted:signal.aborted,inputs}).toEqual({aborted:true,inputs:[]});
});

it('checks owner authority after upload even before a cross-tab storage notification is dispatched',async()=>{
 const view=render(<TerminalMicButton sessionId="synthetic-a" provider="local"/>);
 fireEvent.click(screen.getByLabelText('Voice input (local Whisper)'));
 fireEvent.click(await screen.findByLabelText('Stop recording'));
 await waitFor(()=>expect(api.fetch).toHaveBeenCalledTimes(1));
 // Simulate shared storage already committed by another realm, with its task still queued.
 localStorage.setItem('terminal_auth_session','synthetic-other-realm-session');
 localStorage.setItem('terminal_user',JSON.stringify({id:'synthetic-owner-b'}));
 await act(async()=>transcription.resolve({ok:true,json:async()=>({text:'synthetic stale owner transcript'})}));
 expect(inputs).toEqual([]);
 view.unmount();
});
