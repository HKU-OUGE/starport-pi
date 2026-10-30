#!/usr/bin/env node
import readline from 'node:readline/promises';
import path from 'node:path';
import {stateRoot,load,writePrivate,save} from '../src/config.mjs';
import {configure,operatorCommand,secretPrompt} from '../src/console.mjs';
import {Remote} from '../src/transport.mjs';
import {requireModelProxy} from '../src/network.mjs';
import {makeSession} from '../src/session.mjs';
import {spawn} from 'node:child_process';

async function main() {
  const action=process.argv[2];
  if(action==='--version'){console.log('Starport Pi 0.3.1');return;}
  if(action==='--help'){console.log('starport-pi [configure | auth | panel [PORT] | verify-server | doctor | probe | --print MESSAGE]\nInteractive: /starport /network /servers /workspace /tunnel /upload /download /help');return;}
  const root=stateRoot();let config=load(root);
  if(action==='panel'){
    const {startPanel}=await import('../src/panel.mjs');const app=await startPanel(root,{port:Number(process.argv.slice(3).find(x=>/^\d+$/.test(x))||18900)});
    console.log('Starport Pi: http://127.0.0.1:'+app.port+'\nLocal access key: '+app.key+'\nKeep this key private. Cloudflare mode requires Access login instead.');
    if(process.argv.includes('--open')){
      const url='http://127.0.0.1:'+app.port+'/';
      const program=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
      const browser=spawn(program,process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url],{stdio:'ignore',windowsHide:true,detached:true,shell:false});
      browser.on('error',()=>console.log('Open the loopback URL above in your browser.'));browser.unref();
    }
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit()));return;
  }
  if(action==='configure'){await configure(root,process.argv[3]||'menu');return;}
  if(action==='auth') {
    const key=await secretPrompt('Anthropic API Key（隱藏輸入）: ');
    if(!key.startsWith('sk-ant-'))throw new Error('invalid_api_key');writePrivate(path.join(root,'secrets.json'),{anthropicApiKey:key});console.log('API Key 已儲存。');return;
  }
  const remote=new Remote(config,root);
  if(action==='verify-server'){console.log(await remote.verifyHost());return;}
  if(action==='doctor'){const r=await remote.call('health');delete r.egress_socket;console.log(JSON.stringify(r,null,2));return;}
  if(action==='probe') {
    if(!config.workspace){config.workspace=(await remote.call('workspace.create')).id;save(config,root);}
    const r=await remote.call('job.submit',{command:'python3 /opt/starport/probe.py',cpus:1,memory_gib:2,timeout:120});console.log(JSON.stringify(r,null,2));return;
  }
  if(action==='rpc') {
    // Operator-only diagnostic. Model calls never enter the CLI dispatcher.
    let input='';for await(const block of process.stdin){input+=block;if(input.length>8*1024*1024)throw new Error('request_too_large');}
    const request=JSON.parse(input);const {operation,...args}=request;console.log(JSON.stringify(await remote.call(operation,args)));return;
  }
  console.log('✦ Starport Pi · 遠端工作台\n輸入 /starport 開啟設定，/help 查看操作。');
  let session=null;let route='';let dispatcher=null;
  async function prompt(message) {
    if(!config.activeServer||!config.workspace)throw new Error('select_server_and_create_workspace_first');
    const current=JSON.stringify([config.activeServer,config.workspace,config.model,config.effort,config.proxy.port,config.proxy.selected]);
    if(!session||route!==current){
      session?.dispose();if(dispatcher)await dispatcher.close();dispatcher=requireModelProxy(config);
      const result=await makeSession(config,root,remote);session=result.session;route=current;
      session.subscribe(event=>{
        if(event.type==='message_update'&&event.assistantMessageEvent?.type==='text_delta')process.stdout.write(event.assistantMessageEvent.delta.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,''));
        if(event.type==='tool_execution_start')console.log(`\n▸ ${event.toolName}`);
        if(event.type==='tool_execution_end')console.log(event.isError?'  失敗':'  完成');
      });
    }
    const started=Date.now();await session.prompt(message);
    if(session.agent.state.messages.at(-1)?.stopReason==='error')throw new Error('model_request_failed_check_api_key_or_proxy');
    console.log(`\n· ${((Date.now()-started)/1000).toFixed(1)}s`);
  }
  try{
    if(action==='--print'){await prompt(process.argv.slice(3).join(' '));return;}
    while(true){
      const rl=readline.createInterface({input:process.stdin,output:process.stdout});let line;
      try{line=await rl.question('\n你 › ');}finally{rl.close();}
      if(line.trim()==='/exit')break;if(!line.trim())continue;
      try{
        if(line.startsWith('/')){if(!await operatorCommand(line,config,root,remote))console.log('未知操作。請輸入 /help。');}
        else await prompt(line);
      }catch(e){console.error('錯誤：'+(/^[a-z0-9_ -]{1,120}$/i.test(e.message)?e.message:'operation_failed'));}
    }
  }finally{session?.dispose();if(dispatcher)await dispatcher.close();}
}
main().catch(error=>{console.error('Starport Pi: '+(/^[a-z0-9_ -]{1,120}$/i.test(error.message)?error.message:'operation_failed'));process.exitCode=1;});
