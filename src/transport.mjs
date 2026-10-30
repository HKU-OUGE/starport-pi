import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {id, validateServer, privateDir} from './config.mjs';

const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REMOTE_RPC='python3 -I "$HOME/.local/share/starport-pi-server/worker.py" rpc';
export function sshArgs(name,server,root,{forward=false}={}) {
  id(name);validateServer(server);
  const args=['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no',
    '-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-o','ConnectTimeout=12'];
  if (!forward) args.push('-o','ClearAllForwardings=yes');
  if(server.knownHostsFile){
    const file=server.knownHostsFile.replaceAll('\\','/').replaceAll('"','\\"').replaceAll('%','%%');
    args.push('-o',`UserKnownHostsFile="${file}"`,'-o','GlobalKnownHostsFile=none');
  }
  if (server.mode==='ssh') {
    if(server.port)args.push('-p',String(server.port));
    if(server.identityFile)args.push('-i',server.identityFile,'-o','IdentitiesOnly=yes');
    return [...args,server.host];
  }
  const quote=value=> '"'+value.replaceAll('\\','/').replaceAll('"','\\"').replaceAll('%','%%')+'"';
  const python=process.env.STARPORT_PYTHON || (process.platform==='win32' ? 'python' : 'python3');
  // Only operator configuration constructs this command, never a tool argument.
  const command=[python,path.join(packageRoot,'scripts','dsw_proxy.py'),'--state',root,'--server',name].map(quote).join(' ');
  args.push('-o',`ProxyCommand=${command}`,'-o',`HostKeyAlias=starport-${name}`,'-i',server.identityFile,
    '-o','IdentitiesOnly=yes',`${server.user}@starport-${name}`);
  return args;
}

export function processCall(program,args,input,{timeout=45000,maxBytes=8*1024*1024,signal}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    let length=0;const blocks=[];let errorBytes=0;let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>{child.kill();finish(new Error('remote_operation_interrupted'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('remote_outcome_unknown'));},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',()=>finish(new Error('ssh_unavailable')));
    child.stdout.on('data',data=>{length+=data.length;if(length>maxBytes){child.kill();finish(new Error('remote_response_too_large'));}else blocks.push(data);});
    // Never forward ProxyClient diagnostics, usernames or connection addresses to a model.
    child.stderr.on('data',data=>{errorBytes+=data.length;if(errorBytes>16*1024*1024)child.kill();});
    child.on('close',code=>finish(code===0?null:new Error('server_connection_failed'),Buffer.concat(blocks)));
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}

export class Remote {
  constructor(config,root,{call=processCall}={}) {this.config=config;this.root=root;this.callProcess=call;}
  selected() {
    const name=this.config.activeServer;const server=this.config.servers[name];
    if (!server) throw new Error('select_server_first');
    return {name,server};
  }
  async call(operation,parameters={},options={}) {
    const {name,server}=this.selected();
    const body={operation,...parameters};
    if (operation!=='health' && operation!=='workspace.create') {
      if (!/^[a-f0-9]{32}$/.test(this.config.workspace||'')) throw new Error('select_workspace_first');
      body.workspace=this.config.workspace;
    }
    const buffer=await this.callProcess('ssh',[...sshArgs(name,server,this.root),REMOTE_RPC],JSON.stringify(body),options);
    let result;try{result=JSON.parse(buffer);}catch{throw new Error('invalid_server_response');}
    if (!result.ok) throw new Error(/^[a-z0-9_]{1,80}$/.test(result.error||'') ? result.error : 'remote_operation_failed');
    return result.result;
  }
  async tunnel(proxyPort) {
    if (!Number.isInteger(proxyPort)||proxyPort<1024||proxyPort>65535) throw new Error('invalid_proxy_port');
    const {name,server}=this.selected();
    const status=await this.call('health');
    if (!/^\/tmp\/starport-egress-[a-f0-9]{32}\/proxy\.sock$/.test(status.egress_socket||'')) throw new Error('invalid_egress_binding');
    if (status.egress_ready) return {close:()=>{},process:null,reused:true};
    const args=sshArgs(name,server,this.root,{forward:true});
    args.splice(args.length-1,0,'-N','-o','ExitOnForwardFailure=yes','-o','StreamLocalBindUnlink=yes',
      '-o','StreamLocalBindMask=0111','-R',`${status.egress_socket}:127.0.0.1:${proxyPort}`);
    const child=spawn('ssh',args,{stdio:'ignore',windowsHide:true,shell:false,detached:true});
    child.on('error',()=>{});
    await new Promise(r=>setTimeout(r,500));
    if(child.exitCode!==null)throw new Error('egress_tunnel_failed');
    child.unref();
    return {close:()=>child.kill(),process:child};
  }
  async configureGpu(indices,{apply=false}={}) {
    if(!Array.isArray(indices)||!indices.length||indices.some(n=>!Number.isInteger(n)||n<0)||new Set(indices).size!==indices.length)throw new Error('invalid_gpu_indices');
    const {name,server}=this.selected();
    const command=`python3 -I "$HOME/.local/share/starport-pi-server/configure_gpu.py" --indices ${indices.join(',')}${apply?' --apply':''}`;
    return JSON.parse(await this.callProcess('ssh',[...sshArgs(name,server,this.root),command],'',{timeout:60000}));
  }
  async verifyHost() {
    const {name,server}=this.selected();
    const args=sshArgs(name,server,this.root).map(value=>value==='BatchMode=yes'?'BatchMode=no':value==='StrictHostKeyChecking=yes'?'StrictHostKeyChecking=ask':value);
    await new Promise((resolve,reject)=>{
      const child=spawn('ssh',[...args,'true'],{stdio:'inherit',windowsHide:false,shell:false});
      child.on('error',()=>reject(new Error('ssh_unavailable')));
      child.on('close',code=>code===0?resolve():reject(new Error('server_verification_failed')));
    });
    return {verified:true};
  }
}
