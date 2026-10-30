import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseSubscription,normalizeNode,ModelProxy,publicIPv4,startProxy} from '../src/network.mjs';
import {sshArgs,Remote} from '../src/transport.mjs';
import {load,publicConfig,save,validateServer} from '../src/config.mjs';
import {makeTools} from '../src/tools.mjs';
import http from 'node:http';

test('subscription parsing drops provider rules and blocks executable/TLS overrides',()=>{
  const raw='proxies:\n  - name: Example\n    type: trojan\n    server: node.example.invalid\n    port: 443\n    password: example-password\nrules: [MATCH,DIRECT]\nexternal-controller: 0.0.0.0:9090\n';
  const value=parseSubscription(raw);assert.equal(value.nodes.length,1);assert.equal(value.nodes[0].udp,false);
  assert.equal(value.nodes[0]['external-controller'],undefined);assert.equal(value.rules,undefined);
  assert.throws(()=>normalizeNode({...value.nodes[0],'skip-cert-verify':true}),/insecure_tls/);
  assert.throws(()=>normalizeNode({...value.nodes[0],'ws-opts':{'command':'unexpected'}}),/subscription_invalid/);
  assert.throws(()=>parseSubscription('proxies: [&x {type: trojan, server: example.invalid, port: 443, password: example}, *x]'),/alias/);
});
test('applying another node reloads only the authenticated private controller',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'starport-proxy-'));
  const secret='a'.repeat(64),seen=[];
  const server=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${secret}`);
    if(req.url==='/version'){res.setHeader('Content-Type','application/json');res.end('{"version":"test"}');return;}
    let body='';for await(const data of req)body+=data;
    seen.push([req.url,req.method,JSON.parse(body)]);res.writeHead(204);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const config=load(root);config.proxy.binary='not-executed';config.proxy.selected='sub-aaaaaaaaaaaa:0';
    fs.mkdirSync(path.join(root,'network'));fs.writeFileSync(path.join(root,'network','controller.json'),JSON.stringify({secret,port:server.address().port}));
    fs.mkdirSync(path.join(root,'subscriptions'));fs.writeFileSync(path.join(root,'subscriptions','sub-aaaaaaaaaaaa.json'),JSON.stringify({nodes:[{name:'Test',type:'trojan',server:'1.1.1.1',port:443,password:'example-password'}]}));
    const result=await startProxy(config,root);assert.equal(result.reloaded,true);
    assert.equal(seen.length,1);assert.deepEqual(seen[0].slice(0,2),['/configs?force=true','PUT']);
    assert.ok(!seen[0][2].payload.includes('DIRECT'));assert.ok(seen[0][2].payload.includes('MATCH,EGRESS'));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
test('common URI and base64 subscriptions',()=>{
  const uri='trojan://example-password@node.example.invalid:443?security=tls#Example';
  assert.equal(parseSubscription(uri).nodes[0].password,'example-password');
  assert.equal(parseSubscription(Buffer.from(uri).toString('base64')).nodes[0].type,'trojan');
  assert.equal(parseSubscription('ss://'+Buffer.from('aes-256-gcm:example-password').toString('base64')+'@node.example.invalid:443#Example').nodes[0].cipher,'aes-256-gcm');
  const ss='ss://'+Buffer.from('aes-256-gcm:example-password').toString('base64')+'@node.example.invalid:443?plugin='+encodeURIComponent('obfs-local;obfs=tls;obfs-host=www.example.com');
  const node=parseSubscription(ss).nodes[0];assert.equal(node.plugin,'obfs');assert.equal(node['plugin-opts'].mode,'tls');
  assert.equal(normalizeNode(node)['plugin-opts'].host,'www.example.com');
  assert.throws(()=>normalizeNode({...node,plugin:'external-command'}),/unsupported_node_plugin/);
});
test('private endpoint ranges rejected',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','::1','100.64.0.1'])assert.equal(publicIPv4(ip),false);
  assert.equal(publicIPv4('1.1.1.1'),true);
});
test('model transport never falls back to direct or arbitrary endpoint',async()=>{
  let calls=0;const proxy=new ModelProxy(18889,{inner:{dispatch(){calls++;throw new Error('proxy_down');},close(){},destroy(){}}});
  assert.throws(()=>proxy.dispatch({origin:'https://api.anthropic.com'},{onError(){}}),/proxy_down/);assert.equal(calls,1);
  const error=await new Promise(resolve=>proxy.dispatch({origin:'https://example.invalid'},{onError:resolve}));assert.equal(error.message,'model_endpoint_not_allowed');assert.equal(calls,1);
});
test('operator private state has no secrets in public view',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'starport test '));
  try{const cfg=load(root);cfg.servers.alpha={mode:'ssh',host:'example-user@example.invalid'};save(cfg,root);
    assert.equal(JSON.stringify(publicConfig(load(root))).includes('example-user'),false);
    if(process.platform!=='win32')assert.equal(fs.statSync(path.join(root,'config.json')).mode&0o777,0o600);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('SSH fixed command, public server alias and workspace binding',async()=>{
  const cfg={activeServer:'alpha',workspace:'a'.repeat(32),servers:{alpha:{mode:'ssh',host:'example-host'}}};let seen;
  const remote=new Remote(cfg,os.tmpdir(),{call:async(program,args,input)=>{seen={program,args,body:JSON.parse(input)};return Buffer.from('{"ok":true,"result":{"ready":true}}');}});
  await remote.call('file.read',{path:'project.py'});assert.equal(seen.program,'ssh');assert.equal(seen.body.workspace,cfg.workspace);
  assert.equal(seen.args.at(-1),'python3 -I "$HOME/.local/share/starport-pi-server/worker.py" rpc');
  assert.ok(seen.args.includes('StrictHostKeyChecking=yes'));assert.ok(seen.args.includes('ForwardAgent=no'));
  assert.throws(()=>validateServer({mode:'ssh',host:'host; echo invalid'}),/invalid_ssh_host/);
  assert.throws(()=>sshArgs('bad/name',cfg.servers.alpha,os.tmpdir()),/invalid_name/);
});
test('model tools have no operator configuration or local execution entry',async()=>{
  const calls=[];const tools=makeTools({call:async(op,args)=>{calls.push([op,args]);return {id:'a'.repeat(32)};}});
  assert.ok(!tools.some(t=>/local|config|subscription|ssh|network/.test(t.name)));
  await tools.find(t=>t.name==='bash').execute('t',{command:'printf test'},null);
  assert.equal(calls[0][0],'job.submit');assert.equal(calls[0][1].command,'printf test');
  for(const tool of tools)assert.equal(tool.parameters.additionalProperties,false);
});
