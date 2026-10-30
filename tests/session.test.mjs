import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {makeSession,SYSTEM_PROMPT} from '../src/session.mjs';
import {MockAgent,setGlobalDispatcher,getGlobalDispatcher} from 'undici';
import {ModelProxy} from '../src/network.mjs';

test('real Pi SDK routes tool calls remotely and excludes operator context',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'starport-sdk-'));
  const previous=getGlobalDispatcher(),network=new MockAgent();network.disableNetConnect();setGlobalDispatcher(network);
  let session;
  try{
    const runtime=await ModelRuntime.create({authPath:path.join(root,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
    await runtime.setRuntimeApiKey('anthropic','example-test-key');
    const requests=[],calls=[];
    const streamFn=(model,context)=>{
      requests.push(structuredClone(context));
      const first=requests.length===1;
      const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
        content:first?[{type:'toolCall',id:'remote-check',name:'bash',arguments:{command:'printf remote-only'}}]:[{type:'text',text:'Remote job submitted.'}],
        stopReason:first?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end(message);});return stream;
    };
    const config={activeServer:'server',workspace:'a'.repeat(32),model:'claude-sonnet-5-5',effort:'high'};
    const result=await makeSession(config,root,{call:async(op,args)=>{calls.push([op,args]);return {id:'b'.repeat(32),status:'queued'};}},{modelRuntime:runtime,streamFn,inMemory:true});
    session=result.session;
    assert.equal(result.extensionsResult.errors.length,0);
    assert.deepEqual(session.getActiveToolNames().sort(),result.tools.map(t=>t.name).sort());
    await session.prompt('Run the remote test.');
    assert.equal(requests.length,2);
    assert.deepEqual(calls,[['job.submit',{command:'printf remote-only'}]]);
    for(const request of requests){
      assert.ok(JSON.stringify(request).includes(SYSTEM_PROMPT));
      assert.ok(!JSON.stringify(request).includes(root));
      assert.ok(!JSON.stringify(request).includes(os.homedir()));
      const exposed=request.tools||request.messages.flatMap(m=>m.toolsAdded||[]);
      assert.ok(!exposed.some(t=>['exec','local_bash','grep','find'].includes(t.name)));
    }
    assert.ok(requests[1].messages.some(m=>m.role==='toolResult'));
  }finally{session?.dispose();setGlobalDispatcher(previous);await network.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('actual Pi provider transport goes through the required proxy and fails closed',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'starport-provider-'));
  const previous=getGlobalDispatcher();let attempted=0,session;
  const dispatcher=new ModelProxy(18889,{inner:{dispatch(_options,handler){attempted++;queueMicrotask(()=>handler.onError(new Error('validation_proxy_offline')));return false;},close(){return Promise.resolve();},destroy(){return Promise.resolve();}}});
  setGlobalDispatcher(dispatcher);
  try{
    const runtime=await ModelRuntime.create({authPath:path.join(root,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
    await runtime.setRuntimeApiKey('anthropic','example-test-key');
    const made=await makeSession({activeServer:'server',workspace:'a'.repeat(32),model:'claude-sonnet-5-5',effort:'off'},root,{call:()=>{throw new Error('unexpected_tool');}},{modelRuntime:runtime,inMemory:true});
    session=made.session;session.settingsManager?.setRetryEnabled?.(false);
    await session.prompt('Connectivity test.');
    assert.ok(attempted>0);
    assert.equal(session.agent.state.messages.at(-1).stopReason,'error');
  }finally{session?.dispose();setGlobalDispatcher(previous);await dispatcher.close();fs.rmSync(root,{recursive:true,force:true});}
});
