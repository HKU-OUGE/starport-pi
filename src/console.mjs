import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {load,save,id,publicConfig,validateServer,writePrivate} from './config.mjs';
import {importSubscription,listNodes,startProxy,refreshSubscription,proxyStatus} from './network.mjs';
import {upload,download} from './files.mjs';
import {installRemote} from './install-remote.mjs';

export async function secretPrompt(label) {
  if(!process.stdin.isTTY)throw new Error('secret_requires_terminal');
  process.stdout.write(label);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';const done=error=>{process.stdin.off('data',receive);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};
    const receive=block=>{for(const c of block.toString('utf8')){
      if(c==='\u0003'){done(new Error('cancelled'));return;}
      if(c==='\r'||c==='\n'){done();return;}
      if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else if(c>=' ')value+=c;
    }};process.stdin.on('data',receive);
  });
}

export async function configure(root,section='menu') {
  const config=load(root);const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  const ask=async(label,initial='')=>(await rl.question(`${label}${initial?' ['+initial+']':''}: `)).trim()||initial;
  try{
    if(section==='menu')section=await ask('1 訂閱與出口 · 2 伺服器 · 3 模型設定 · 4 查看設定','4');
    if(section==='1'||section==='network') {
      const action=await ask('1 新增 HTTPS 訂閱 · 2 匯入訂閱檔 · 3 選擇出口 · 4 設定 Mihomo · 5 啟動／套用出口 · 6 更新訂閱 · 7 狀態','3');
      if(action==='1'||action==='2'){
        const label=await ask('訂閱名稱');const source=await ask(action==='1'?'HTTPS 訂閱網址':'訂閱檔路徑');
        const r=await importSubscription(config,root,label,source,{remote:action==='1'});console.log(`已匯入 ${r.nodes} 個節點。`);
      } else if(action==='3') {
        const nodes=listNodes(config,root);nodes.forEach((n,i)=>console.log(`${i+1}. ${n.subscription} / ${n.label} (${n.type})`));
        const n=nodes[Number(await ask('節點編號'))-1];if(!n)throw new Error('invalid_node_selection');config.proxy.selected=n.id;save(config,root);
        console.log('已儲存。選擇「啟動／套用出口」使設定生效。');
      } else if(action==='4') {
        config.proxy.binary=path.resolve(await ask('Mihomo 執行檔路徑'));const port=Number(await ask('本機代理連接埠',String(config.proxy.port)));
        if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_port');config.proxy.port=port;save(config,root);
      } else if(action==='5') console.log(await startProxy(config,root));
      else if(action==='6'){
        config.subscriptions.forEach((s,i)=>console.log(`${i+1}. ${s.label}`));
        const selected=config.subscriptions[Number(await ask('訂閱編號'))-1];if(!selected)throw new Error('subscription_not_found');
        console.log(await refreshSubscription(config,root,selected.id));
      }else if(action==='7')console.log(await proxyStatus(config,root));
    } else if(section==='2'||section==='servers') {
      const action=await ask('1 新增 SSH 伺服器 · 2 新增阿里 DSW · 3 選擇伺服器','3');
      if(action==='1'||action==='2') {
        const name=id(await ask('公開別名（英文字母、數字、連字號）'));let entry;
        if(action==='1')entry={mode:'ssh',host:await ask('既有 SSH 別名或 user@host')};
        else entry={mode:'dsw',instanceId:await ask('DSW instance ID'),region:await ask('DSW 實際區域 ID'),
          user:await ask('SSH 使用者','root'),proxyClient:path.resolve(await ask('ProxyClient 執行檔')),
          credentialsFile:path.resolve(await ask('ProxyClient 私有憑證設定檔')),identityFile:path.resolve(await ask('SSH 私鑰檔'))};
        validateServer(entry);config.servers[name]=entry;config.activeServer=name;config.workspace=null;save(config,root);
      } else {
        const names=Object.keys(config.servers);names.forEach((n,i)=>console.log(`${i+1}. ${n}`));
        const name=names[Number(await ask('伺服器編號'))-1];if(!name)throw new Error('invalid_server_selection');
        config.activeServer=name;config.workspace=null;save(config,root);
      }
    } else if(section==='3'||section==='model') {
      config.model=await ask('Anthropic 模型 ID',config.model);config.effort=await ask('effort: off / minimal / low / medium / high / xhigh / max',config.effort);
      if(!['off','minimal','low','medium','high','xhigh','max'].includes(config.effort))throw new Error('invalid_effort');save(config,root);
    } else console.log(JSON.stringify(publicConfig(config),null,2));
  }finally{rl.close();}
  return config;
}

export async function operatorCommand(line,config,root,remote) {
  const [command,...rest]=line.trim().split(/\s+/);
  if(['/starport','/network','/servers','/model'].includes(command)) {
    const next=await configure(root,command==='/starport'?'menu':command.slice(1));Object.assign(config,next);return true;
  }
  if(command==='/workspace') {
    const result=await remote.call('workspace.create');config.workspace=result.id;save(config,root);console.log(result);return true;
  }
  if(command==='/status') {const r=await remote.call('health');delete r.egress_socket;console.log(r);return true;}
  if(command==='/verify-server') {console.log(await remote.verifyHost());return true;}
  if(command==='/tunnel') {const r=await remote.tunnel(config.proxy.port);console.log({connected:true,reused:Boolean(r.reused)});return true;}
  if(command==='/locale') {console.log('Asia/Taipei · zh_TW.UTF-8 · UTF-8 · Noto CJK TC');return true;}
  if(command==='/gpu') {
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try{
      const indices=(await rl.question('此服務專用的 GPU 編號（逗號分隔）: ')).split(',').map(Number);
      console.log(await remote.configureGpu(indices));
      if((await rl.question('確認資源已保留給此服務，輸入 APPLY 套用: '))==='APPLY')console.log(await remote.configureGpu(indices,{apply:true}));
    }finally{rl.close();}return true;
  }
  if(command==='/upload') {
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try{
      const source=await rl.question('本機檔案: ');const target=await rl.question('遠端相對路徑: ');
      const key=crypto.createHash('sha256').update(config.activeServer+'\0'+config.workspace+'\0'+source+'\0'+target).digest('hex');
      console.log(await upload(remote,source,target,{resumeFile:path.join(root,'upload-'+key+'.json'),progress:(n,total)=>process.stdout.write(`\r${n}/${total} bytes`)}));
    }finally{rl.close();}return true;
  }
  if(command==='/download') {
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try{console.log(await download(remote,await rl.question('任務 ID: '),await rl.question('產物相對路徑: '),await rl.question('本機儲存路徑: ')));}finally{rl.close();}return true;
  }
  if(command==='/install-server') {
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try{
      const archive=await rl.question('乾淨 rootfs.tar 檔案: ');const cpus=Number(await rl.question('CPU 預算: '));const memoryGiB=Number(await rl.question('記憶體預算（GiB）: '));
      if((await rl.question('只在目前選定的既有伺服器新增環境，輸入 INSTALL 繼續: '))!=='INSTALL')return true;
      console.log(await installRemote(config,root,archive,{cpus,memoryGiB,onProgress:(a,b)=>process.stdout.write(`\r${a}/${b} bytes`)}));
    }finally{rl.close();}return true;
  }
  if(command==='/help') {
    console.log('/starport /network /servers /verify-server /model /workspace /status /locale /tunnel /install-server /gpu /upload /download /exit\n一般文字會傳給 Claude。所有模型工具均使用遠端工作區。');return true;
  }
  return false;
}
