import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import {spawn} from 'node:child_process';
import {parseDocument,stringify} from 'yaml';
import {Agent,Dispatcher,ProxyAgent,setGlobalDispatcher} from 'undici';
import {privateDir,writePrivate,save,id} from './config.mjs';

const LIMIT=4*1024*1024;
const FIELDS=new Set(['name','type','server','port','cipher','password','uuid','alterId','tls','servername','sni','alpn','client-fingerprint','network','flow','reality-opts','ws-opts','grpc-opts']);
const decode=value=>Buffer.from(value,'base64url').toString('utf8');
function uri(line) {
  if(line.startsWith('vmess://')) {
    const d=JSON.parse(decode(line.slice(8)));
    return {name:d.ps||'VMess',type:'vmess',server:d.add,port:Number(d.port),uuid:d.id,alterId:Number(d.aid||0),cipher:d.scy||'auto',tls:d.tls==='tls',servername:d.sni||d.host||d.add,network:d.net||'tcp',...(d.net==='ws'?{'ws-opts':{path:d.path||'/',headers:{Host:d.host||d.add}}}:{})};
  }
  if(line.startsWith('ss://') && !line.split('#')[0].includes('@')) {
    const [encoded,label]=line.slice(5).split('#');return uri('ss://'+decode(encoded)+(label?'#'+label:''));
  }
  const u=new URL(line);const type=u.protocol.slice(0,-1);const q=u.searchParams;
  const n={name:decodeURIComponent(u.hash.slice(1))||type,type,server:u.hostname,port:Number(u.port||443)};
  if(type==='ss') {
    const auth=u.password?`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`:decode(decodeURIComponent(u.username));
    const at=auth.indexOf(':');if(at<1)throw new Error('subscription_invalid');
    Object.assign(n,{cipher:auth.slice(0,at),password:auth.slice(at+1)});
  } else if(type==='vless'||type==='trojan') {
    n[type==='vless'?'uuid':'password']=decodeURIComponent(u.username);
    n.tls=type==='trojan'||['tls','reality'].includes(q.get('security'));
    n.network=q.get('type')||'tcp';
    if(q.get('sni'))n[type==='vless'?'servername':'sni']=q.get('sni');
    if(q.get('fp'))n['client-fingerprint']=q.get('fp');
    if(q.get('flow'))n.flow=q.get('flow');
    if(q.get('pbk'))n['reality-opts']={'public-key':q.get('pbk'),'short-id':q.get('sid')||''};
    if(n.network==='ws')n['ws-opts']={path:q.get('path')||'/',headers:{Host:q.get('host')||u.hostname}};
    if(n.network==='grpc')n['grpc-opts']={'grpc-service-name':q.get('serviceName')||''};
  } else throw new Error('unsupported_subscription_protocol');
  return n;
}
export function normalizeNode(value) {
  if(!value||typeof value!=='object'||!['ss','vmess','vless','trojan'].includes(value.type))throw new Error('unsupported_subscription_protocol');
  if(value['skip-cert-verify'])throw new Error('insecure_tls_node_rejected');
  if(value.plugin)throw new Error('unsupported_node_plugin');
  const n=Object.fromEntries(Object.entries(value).filter(([k])=>FIELDS.has(k)));
  if(typeof n.server!=='string'||!/^[-a-zA-Z0-9.:[\]]{1,253}$/.test(n.server)||!Number.isInteger(Number(n.port))||Number(n.port)<1||Number(n.port)>65535)throw new Error('subscription_invalid');
  n.port=Number(n.port);n.name=String(n.name||n.type).slice(0,160);n.udp=false;
  if(!['tcp','ws','grpc'].includes(n.network||'tcp'))throw new Error('unsupported_node_transport');
  const serialized=JSON.stringify(n);if(serialized.length>16384)throw new Error('subscription_invalid');
  const inspect=(v,depth=0)=>{
    if(depth>5)throw new Error('subscription_invalid');
    if(Array.isArray(v)){if(v.length>30)throw new Error('subscription_invalid');v.forEach(x=>inspect(x,depth+1));}
    else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){
      if(/file|command|script|private.key|path-to/i.test(k))throw new Error('subscription_invalid');inspect(x,depth+1);
    } else if(!['string','number','boolean'].includes(typeof v)&&v!==null)throw new Error('subscription_invalid');
  };inspect(n);return n;
}
export function parseSubscription(raw) {
  if(typeof raw!=='string'||Buffer.byteLength(raw)>LIMIT)throw new Error('subscription_too_large');
  raw=raw.trim();if(!raw.includes('://')&&!/[\n:{}]/.test(raw))raw=decode(raw);
  let nodes,hosts={};
  if(/^(ss|vmess|vless|trojan):\/\//.test(raw))nodes=raw.split(/\r?\n/).filter(Boolean).map(uri);
  else {
    const doc=parseDocument(raw);if(doc.errors.length)throw new Error('subscription_invalid');
    let d;try{d=doc.toJS({maxAliasCount:0});}catch{throw new Error('subscription_alias_rejected');}
    nodes=Array.isArray(d)?d:d?.proxies||d?.payload;hosts=d?.hosts||{};
  }
  if(!Array.isArray(nodes)||nodes.length<1||nodes.length>2000)throw new Error('subscription_invalid');
  return {nodes:nodes.map(normalizeNode),hosts};
}
export function publicIPv4(ip) {
  if(net.isIP(ip)!==4)return false;
  const [a,b]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
}
export async function fetchSubscription(url) {
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw new Error('https_subscription_required');
  const ips=await dns.resolve4(u.hostname);if(!ips.length||!ips.every(publicIPv4))throw new Error('public_subscription_endpoint_required');
  const dispatcher=new Agent({connect:{lookup:(_host,options,cb)=>options.all?cb(null,[{address:ips[0],family:4}]):cb(null,ips[0],4)}});
  try{
    const r=await fetch(u,{dispatcher,redirect:'error',signal:AbortSignal.timeout(25000)});
    if(!r.ok)throw new Error('subscription_fetch_failed');
    let size=0;const blocks=[];for await(const block of r.body){size+=block.length;if(size>LIMIT)throw new Error('subscription_too_large');blocks.push(block);}
    return Buffer.concat(blocks).toString('utf8');
  }finally{await dispatcher.close();}
}
export async function importSubscription(config,root,label,source,{remote=true}={}) {
  const raw=remote?await fetchSubscription(source):fs.readFileSync(source,'utf8');
  const parsed=parseSubscription(raw);const sid='sub-'+crypto.randomBytes(6).toString('hex');
  writePrivate(path.join(root,'subscriptions',sid+'.json'),{...parsed,url:remote?source:null});
  config.subscriptions.push({id:sid,label:String(label).slice(0,80)});save(config,root);
  return {id:sid,nodes:parsed.nodes.length};
}
export async function refreshSubscription(config,root,sid) {
  if(!config.subscriptions.some(s=>s.id===sid))throw new Error('subscription_not_found');
  const file=path.join(root,'subscriptions',id(sid)+'.json');
  const previous=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!previous.url)throw new Error('local_subscription_reimport_required');
  const next=parseSubscription(await fetchSubscription(previous.url));
  if(config.proxy.selected?.startsWith(sid+':')){
    const old=previous.nodes[Number(config.proxy.selected.split(':')[1])];
    const index=next.nodes.findIndex(n=>n.name===old?.name && n.type===old?.type && n.server===old?.server);
    config.proxy.selected=index<0?null:`${sid}:${index}`;
  }
  writePrivate(file,{...next,url:previous.url});save(config,root);
  return {updated:true,nodes:next.nodes.length,selectionRetained:Boolean(config.proxy.selected)};
}
export function listNodes(config,root) {
  return config.subscriptions.flatMap(s=>{
    const data=JSON.parse(fs.readFileSync(path.join(root,'subscriptions',id(s.id)+'.json'),'utf8'));
    return data.nodes.map((n,index)=>({id:`${s.id}:${index}`,label:n.name,subscription:s.label,type:n.type}));
  });
}
export async function managedConfig(config,root,selected) {
  const match=/^(sub-[a-f0-9]{12}):(\d+)$/.exec(selected||'');if(!match)throw new Error('select_node_first');
  const sub=JSON.parse(fs.readFileSync(path.join(root,'subscriptions',match[1]+'.json'),'utf8'));
  let node=normalizeNode(sub.nodes[Number(match[2])]);
  let target=node.server;const seen=new Set();
  for(let i=0;i<8 && sub.hosts?.[target];i++){
    if(seen.has(target))throw new Error('endpoint_alias_cycle');seen.add(target);
    const v=sub.hosts[target];if(typeof v!=='string')throw new Error('unsupported_endpoint_alias');target=v;
  }
  const ips=net.isIP(target)?[target]:await dns.resolve4(target);
  if(!ips.length||!ips.every(publicIPv4))throw new Error('public_node_endpoint_required');
  node={...node,name:'selected',server:ips[0]};
  const denied=['0.0.0.0/8','10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','224.0.0.0/4'];
  return {'mixed-port':config.proxy.port,'allow-lan':false,'bind-address':'127.0.0.1',mode:'rule','log-level':'error',ipv6:false,
    proxies:[node],'proxy-groups':[{name:'EGRESS',type:'select',proxies:['selected']}],
    dns:{enable:true,ipv6:false,'respect-rules':true,nameserver:['https://1.1.1.1/dns-query#EGRESS'],'proxy-server-nameserver':['https://1.1.1.1/dns-query#EGRESS']},
    rules:['DOMAIN,localhost,REJECT','DOMAIN-SUFFIX,local,REJECT',...denied.map(c=>`IP-CIDR,${c},REJECT`),'IP-CIDR6,::/0,REJECT','MATCH,EGRESS']};
}
function controller(root,config) {
  const dir=privateDir(path.join(root,'network'));const file=path.join(dir,'controller.json');
  const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{secret:crypto.randomBytes(32).toString('hex'),port:config.proxy.controllerPort||18890};
  if(!/^[a-f0-9]{64}$/.test(data.secret)||!Number.isInteger(data.port)||data.port<1024||data.port>65535||data.port===config.proxy.port)throw new Error('invalid_proxy_controller');
  if(!fs.existsSync(file))writePrivate(file,data);
  return data;
}
async function control(data,route,{method='GET',body}={}) {
  // Explicit loopback dispatcher: never send control credentials to the model proxy.
  const dispatcher=new Agent();
  try{
    const response=await fetch(`http://127.0.0.1:${data.port}${route}`,{dispatcher,redirect:'error',method,
      headers:{Authorization:`Bearer ${data.secret}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(1500)});
    if(!response.ok)throw new Error('proxy_controller_rejected');
    return response.status===204?{}:await response.json();
  }finally{await dispatcher.close();}
}
export async function proxyStatus(config,root) {
  const file=path.join(root,'network','controller.json');
  if(!fs.existsSync(file))return {running:false};
  try{const data=controller(root,config);const version=await control(data,'/version');return {running:true,version:version.version};}
  catch{return {running:false};}
}
export async function startProxy(config,root) {
  if(!config.proxy.binary)throw new Error('configure_mihomo_binary_first');
  const value=await managedConfig(config,root,config.proxy.selected);
  const dir=privateDir(path.join(root,'network'));const file=path.join(dir,'mihomo.yaml');
  const data=controller(root,config);
  value['external-controller']=`127.0.0.1:${data.port}`;value.secret=data.secret;
  const payload=stringify(value);
  if((await proxyStatus(config,root)).running){
    await control(data,'/configs?force=true',{method:'PUT',body:{payload}});
    fs.writeFileSync(file,payload,{mode:0o600});
    writePrivate(path.join(dir,'applied.json'),{selected:config.proxy.selected,updatedAt:new Date().toISOString()});
    return {running:true,reloaded:true};
  }
  // Never replace another application on these ports.
  for(const port of [config.proxy.port,data.port])await new Promise((resolve,reject)=>{
    const listener=net.createServer();listener.once('error',()=>reject(new Error('proxy_port_in_use')));listener.listen(port,'127.0.0.1',()=>listener.close(resolve));
  });
  fs.writeFileSync(file,payload,{mode:0o600});
  const args=['-d',dir,'-f',file];
  const child=spawn(config.proxy.binary,args,{stdio:'ignore',windowsHide:true,detached:true,shell:false});
  let failed=false;child.on('error',()=>{failed=true;});
  for(let attempt=0;attempt<12;attempt++){
    await new Promise(r=>setTimeout(r,250));
    if(failed||child.exitCode!==null)break;
    if((await proxyStatus(config,root)).running){
      child.unref();writePrivate(path.join(dir,'process.json'),{pid:child.pid});
      writePrivate(path.join(dir,'applied.json'),{selected:config.proxy.selected,updatedAt:new Date().toISOString()});
      return {running:true,reloaded:false};
    }
  }
  child.kill();throw new Error('proxy_start_failed');
}
export class ModelProxy extends Dispatcher {
  constructor(port,{inner}={}) {super();this.inner=inner||new ProxyAgent(`http://127.0.0.1:${port}`);}
  dispatch(options,handler){
    const origin=new URL(String(options.origin));
    if(origin.protocol!=='https:'||origin.hostname!=='api.anthropic.com'||origin.port){queueMicrotask(()=>handler.onError(new Error('model_endpoint_not_allowed')));return false;}
    return this.inner.dispatch(options,handler);
  }
  close(...args){return this.inner.close(...args);}
  destroy(...args){return this.inner.destroy(...args);}
}
export function requireModelProxy(config) {
  if(config.proxy.mode!=='required')throw new Error('proxy_required');
  const dispatcher=new ModelProxy(config.proxy.port);setGlobalDispatcher(dispatcher);return dispatcher;
}
