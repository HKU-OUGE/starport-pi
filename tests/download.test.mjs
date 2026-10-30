import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import {Agent,fetch} from 'undici';
import {verifiedDownload,downloadFailure,downloadChecksum} from '../src/download.mjs';
import {safeError} from '../src/panel-store.mjs';
import {operationProgress} from '../web/src/operation-progress.mjs';
const url='https://github.com/example/project/releases/download/v1/rootfs.tar.gz';
const data=crypto.randomBytes(512*1024),hash=crypto.createHash('sha256').update(data).digest('hex');
async function fixture(handler){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'starport-download-')),requests=[],dispatchers=[];
  const server=http.createServer((req,res)=>{requests.push({url:req.url,range:req.headers.range,ifRange:req.headers['if-range']});handler(req,res,requests.length);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const agent=new Agent();
  return {root,requests,dispatchers,fetcher:async(u,options)=>{dispatchers.push(options.dispatcher);return fetch('http://127.0.0.1:'+server.address().port+new URL(u).pathname+new URL(u).search,{...options,dispatcher:agent});},
    async close(){await agent.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}};
}
function seed(root,bytes){const dir=path.join(root,'install-cache');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'rootfs.tar.gz.partial'),data.subarray(0,bytes));}
function rangeResponse(req,res){const offset=Number(/^bytes=(\d+)-$/.exec(req.headers.range||'')?.[1]||0);res.writeHead(offset?206:200,{'content-length':data.length-offset,etag:'"fixture-v1"',...(offset?{'content-range':`bytes ${offset}-${data.length-1}/${data.length}`}:{})});res.end(data.subarray(offset));}

test('interrupted streaming download resumes through the same configured proxy and verifies the full file',async()=>{
 const f=await fixture((req,res,n)=>{if(n===1){res.writeHead(200,{'content-length':data.length,etag:'"fixture-v1"'});res.write(data.subarray(0,131072));setTimeout(()=>res.destroy(),40);}else rangeResponse(req,res);});
 try{
  const progress=[];const file=await verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{proxyPort:18889,fetcher:f.fetcher,wait:async()=>{},onProgress:(b,t,m)=>progress.push({b,t,...m})});
  assert.deepEqual(fs.readFileSync(file),data);assert.equal(f.requests.length,2);assert.equal(f.requests[1].range,'bytes=131072-');assert.equal(f.requests[1].ifRange,'"fixture-v1"');
  assert.ok(progress.some(p=>p.phase==='retrying'&&p.b===131072&&p.error==='download_connection_interrupted'));assert.equal(f.dispatchers[0].constructor.name,'ProxyAgent');assert.equal(new Set(f.dispatchers).size,1);
  assert.equal(fs.existsSync(file+'.partial'),false);assert.equal(fs.existsSync(file+'.lock'),false);
 }finally{await f.close();}
});

test('legacy partials survive a failed attempt and resume on a later invocation',async()=>{
 const f=await fixture(rangeResponse);try{
  seed(f.root,102400);
  await assert.rejects(()=>verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{maxAttempts:1,proxyPort:18889,fetcher:async()=>{throw Object.assign(new Error('private proxy details'),{cause:{code:'ECONNREFUSED'}});}}),/download_proxy_unavailable/);
  assert.equal(fs.statSync(path.join(f.root,'install-cache/rootfs.tar.gz.partial')).size,102400);
  const file=await verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:f.fetcher,wait:async()=>{}});assert.equal(f.requests[0].range,'bytes=102400-');assert.deepEqual(fs.readFileSync(file),data);
 }finally{await f.close();}
});

test('a server ignoring Range replaces the prefix instead of corrupting the file',async()=>{
 const f=await fixture((_req,res)=>{res.writeHead(200,{'content-length':data.length});res.end(data);});try{seed(f.root,1000);const phases=[];const file=await verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:f.fetcher,onProgress:(_b,_t,m)=>phases.push(m.phase)});assert.deepEqual(fs.readFileSync(file),data);assert.ok(phases.includes('restarting'));}finally{await f.close();}
});

test('mismatched ranges and hashes never publish executable content',async()=>{
 const f=await fixture((_req,res)=>{res.writeHead(206,{'content-length':data.length,'content-range':`bytes 0-${data.length-1}/${data.length}`});res.end(data);});try{
  seed(f.root,1000);await assert.rejects(()=>verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:f.fetcher}),/download_range_mismatch/);assert.equal(fs.statSync(path.join(f.root,'install-cache/rootfs.tar.gz.partial')).size,1000);
 }finally{await f.close();}
 const g=await fixture((_req,res)=>res.end(Buffer.from('corrupt payload')));try{
  await assert.rejects(()=>verifiedDownload(g.root,'rootfs.tar.gz',url,hash,{fetcher:g.fetcher,maxAttempts:2,wait:async()=>{}}),/download_checksum_failed/);assert.equal(fs.existsSync(path.join(g.root,'install-cache/rootfs.tar.gz')),false);
 }finally{await g.close();}
});

test('each retry obtains a fresh signed redirect from the original release URL',async()=>{
 let releases=0;const f=await fixture((req,res)=>{
  if(req.url.includes('/releases/')){releases++;res.writeHead(302,{location:'https://release-assets.githubusercontent.com/file?signature=temporary-'+releases});res.end();}
  else if(req.url.endsWith('temporary-1')){res.writeHead(403);res.end();}else rangeResponse(req,res);
 });try{seed(f.root,5000);const file=await verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:f.fetcher,wait:async()=>{}});assert.deepEqual(fs.readFileSync(file),data);assert.equal(releases,2);assert.equal(f.requests[3].range,'bytes=5000-');}finally{await f.close();}
});

test('idle timeout preserves progress and distinguishes timeout from a continuing slow stream',async()=>{
 const f=await fixture((_req,res)=>{res.writeHead(200,{'content-length':data.length});res.write(data.subarray(0,1000));});try{
  await assert.rejects(()=>verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:f.fetcher,idleTimeoutMs:250,attemptTimeoutMs:5000,maxAttempts:1}),/download_idle_timeout/);assert.equal(fs.statSync(path.join(f.root,'install-cache/rootfs.tar.gz.partial')).size,1000);
 }finally{await f.close();}
 const g=await fixture((_req,res)=>{res.writeHead(200,{'content-length':data.length});let n=0;const tick=()=>{const end=Math.min(n+65536,data.length);res.write(data.subarray(n,end));n=end;if(n<data.length)setTimeout(tick,60);else res.end();};tick();});try{
  const file=await verifiedDownload(g.root,'rootfs.tar.gz',url,hash,{fetcher:g.fetcher,idleTimeoutMs:500,attemptTimeoutMs:5000});assert.deepEqual(fs.readFileSync(file),data);
 }finally{await g.close();}
});

test('already verified cache avoids the network and concurrent attempts cannot overwrite a partial',async()=>{
 const f=await fixture(rangeResponse);try{
  const file=await verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:f.fetcher});
  await verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:()=>assert.fail('cached download should not fetch')});
  fs.rmSync(file);let unblock;const gate=new Promise(r=>unblock=r),entered=[];
  const first=verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:async(...args)=>{entered.push(true);await gate;return f.fetcher(...args);}});
  while(!entered.length)await new Promise(r=>setTimeout(r,5));
  await assert.rejects(()=>verifiedDownload(f.root,'rootfs.tar.gz',url,hash,{fetcher:f.fetcher}),/download_cache_busy/);unblock();await first;
 }finally{await f.close();}
});

test('disk, permission and TLS failures keep specific safe codes without private error text',()=>{
 for(const [code,expected]of [['ENOSPC','download_disk_full'],['EACCES','download_cache_permission_denied'],['CERT_HAS_EXPIRED','download_tls_verification_failed']]){
  const error=downloadFailure(Object.assign(new Error('private path and credential must not be returned'),{code}));assert.equal(safeError(error),expected);assert.equal(error.retryable,false);
 }
});

test('the runtime checksum fetch retries transient failures through the configured proxy',async()=>{
 const sum=crypto.createHash('sha512').update(data).digest('hex');
 const f=await fixture((_req,res,n)=>{if(n===1){res.writeHead(503);res.end();}else res.end(sum+'  gvisor.tar.bz2\n');});
 try{
  assert.equal(await downloadChecksum('https://storage.googleapis.com/gvisor/fixture.sha512',{proxyPort:18889,fetcher:f.fetcher,wait:async()=>{}}),sum);
  assert.equal(f.requests.length,2);assert.equal(f.dispatchers[0].constructor.name,'ProxyAgent');assert.equal(new Set(f.dispatchers).size,1);
 }finally{await f.close();}
});

test('panel progress distinguishes saved bytes, retry count and the specific failure',()=>{
 const op={stage:'downloading_rootfs',detail:{phase:'retrying',bytes:111253913,total:165168908,attempt:1,maxAttempts:5,retryInMs:1000,error:'download_connection_interrupted'}};
 const text=operationProgress(op);assert.match(text,/等待重试 2\/5/);assert.match(text,/106\.1 MiB \/ 157\.5 MiB/);assert.match(text,/缓存已保留/);
 const failed=operationProgress({...op,error:'download_disk_full',detail:{...op.detail,phase:'failed'}});assert.match(failed,/缓存磁盘空间不足/);assert.doesNotMatch(failed,/等待重试|operation_failed/);
});

test('a full state disk preserves the classified download error without rejecting the operation promise',async()=>{
 const {Setup}=await import('../src/setup.mjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'starport-download-state-'));
 try{
  const setup=new Setup(root);setup.start('server-initialize',async()=>{setup.record=()=>{throw Object.assign(new Error('private path'),{code:'ENOSPC'});};throw new Error('download_disk_full');});
  await setup.pending;assert.equal(setup.operations[0].status,'failed');assert.equal(setup.operations[0].error,'download_disk_full');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
