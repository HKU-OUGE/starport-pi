import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Agent,ProxyAgent,fetch} from 'undici';
import {privateDir,writePrivate} from './config.mjs';

const HOSTS=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','help-static-aliyun-doc.aliyuncs.com','storage.googleapis.com']);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const problem=(code,retryable=false)=>Object.assign(new Error(code),{retryable});
export function downloadFailure(error,{proxy=false,signal}={}) {
  if(signal?.aborted && /^download_/.test(signal.reason?.message||''))return signal.reason;
  if(/^download_[a-z0-9_]+$/.test(error?.message||''))return error;
  if(['private_directory_is_link','private_file_is_link'].includes(error?.message))return problem('download_cache_file_unsafe');
  if(error?.message==='private_directory_acl_failed')return problem('download_cache_permission_denied');
  const codes=[];for(let e=error;e&&codes.length<5;e=e.cause)codes.push(e.code||e.name);
  if(codes.some(c=>['ENOSPC','EDQUOT'].includes(c)))return problem('download_disk_full');
  if(codes.some(c=>['EACCES','EPERM','EROFS'].includes(c)))return problem('download_cache_permission_denied');
  if(codes.some(c=>['EBUSY','EEXIST'].includes(c)))return problem('download_cache_busy');
  if(codes.some(c=>['ENOTFOUND','EAI_AGAIN'].includes(c)))return problem('download_dns_failed',true);
  if(codes.some(c=>c==='ECONNREFUSED'))return problem(proxy?'download_proxy_unavailable':'download_connection_refused',true);
  if(codes.some(c=>['TimeoutError','AbortError','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT'].includes(c)))return problem('download_connection_timeout',true);
  if(codes.some(c=>/CERT|TLS|SSL|SELF_SIGNED/.test(c||'')))return problem('download_tls_verification_failed');
  if(codes.some(c=>['EIO','ENOENT','ENOTDIR'].includes(c)))return problem('download_cache_io_failed');
  return problem('download_connection_interrupted',true);
}
function allowed(url){
  let u;try{u=new URL(url);}catch{throw problem('download_url_invalid');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!HOSTS.has(u.hostname))throw problem('download_host_not_allowed');
  return u.href;
}
function regular(file){
  try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw problem('download_cache_file_unsafe');return st;}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function hashFile(file,algorithm){
  const h=crypto.createHash(algorithm);for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');
}
function takeLock(file){
  const owner={format:1,pid:process.pid,nonce:crypto.randomBytes(16).toString('hex')};
  for(let i=0;i<2;i++){
    try{
      const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(owner));}finally{fs.closeSync(fd);}
      return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===owner.nonce)fs.rmSync(file);}catch{}};
    }catch(e){
      if(e.code!=='EEXIST')throw e;
      const st=regular(file);if(!st||st.size>1024)throw problem('download_cache_busy');
      let old;try{old=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw problem('download_cache_busy');}
      if(old.format!==1||!Number.isSafeInteger(old.pid)||old.pid<=1||!/^[a-f0-9]{32}$/.test(old.nonce||''))throw problem('download_cache_busy');
      try{process.kill(old.pid,0);throw problem('download_cache_busy');}
      catch(check){if(check.code!=='ESRCH')throw problem('download_cache_busy');}
      fs.rmSync(file);
    }
  }
  throw problem('download_cache_busy');
}
function deadline(idleMs,attemptMs){
  const controller=new AbortController();let timer;
  const idle=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(problem('download_idle_timeout',true)),idleMs);timer.unref();};
  const total=setTimeout(()=>controller.abort(problem('download_attempt_timeout',true)),attemptMs);total.unref();idle();
  return {signal:controller.signal,idle,stop(){clearTimeout(timer);clearTimeout(total);}};
}
async function request(url,headers,dispatcher,clock,fetcher){
  let current=allowed(url);
  for(let n=0;n<6;n++){
    clock.idle();
    const r=await fetcher(current,{dispatcher,redirect:'manual',headers:{'accept-encoding':'identity',...headers},signal:clock.signal});
    clock.idle();
    if([301,302,303,307,308].includes(r.status)){
      let next;try{next=allowed(new URL(r.headers.get('location'),current).href);}finally{await r.body?.cancel();}
      current=next;continue;
    }
    return r;
  }
  throw problem('download_redirect_limit');
}
function httpFailure(status){return problem('download_http_'+status,[408,425,429,500,502,503,504].includes(status)||status===403);}
function length(header){return header&&/^\d+$/.test(header)&&Number.isSafeInteger(Number(header))?Number(header):0;}
function writeAll(fd,block){let done=0;while(done<block.length){const n=fs.writeSync(fd,block,done,block.length-done);if(!n)throw Object.assign(new Error('short write'),{code:'EIO'});done+=n;}}

export async function verifiedDownload(root,name,url,expected,{
  algorithm='sha256',proxyPort,onProgress=()=>{},maxAttempts=5,idleTimeoutMs=120000,
  attemptTimeoutMs=30*60000,maxBytes=512*1024*1024,fetcher=fetch,wait=sleep,
}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(name)||!['sha256','sha512'].includes(algorithm)||!new RegExp('^[a-f0-9]{'+(algorithm==='sha256'?64:128)+'}$').test(expected))throw problem('download_asset_invalid');
  allowed(url);
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10||!Number.isFinite(idleTimeoutMs)||idleTimeoutMs<1||!Number.isFinite(attemptTimeoutMs)||attemptTimeoutMs<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw problem('download_options_invalid');
  if(proxyPort!==undefined&&(!Number.isInteger(proxyPort)||proxyPort<1024||proxyPort>65535))throw problem('download_proxy_port_invalid');
  let unlock,dispatcher;
  try{
    const dir=privateDir(path.join(root,'install-cache')),dest=path.join(dir,name),part=dest+'.partial',metaFile=part+'.json';
    const source=crypto.createHash('sha256').update(url+'\0'+algorithm+'\0'+expected).digest('hex');
    unlock=takeLock(dest+'.lock');
    const complete=regular(dest);
    if(complete){
      if(complete.size>maxBytes||await hashFile(dest,algorithm)!==expected)throw problem('download_cache_checksum_failed');
      onProgress(complete.size,complete.size,{phase:'cached',attempt:0,maxAttempts});return dest;
    }
    let meta={format:1,source};
    if(regular(metaFile)){
      if(fs.statSync(metaFile).size>4096)throw problem('download_cache_metadata_invalid');
      try{meta=JSON.parse(fs.readFileSync(metaFile,'utf8'));}catch{throw problem('download_cache_metadata_invalid');}
      if(meta.format!==1||meta.source!==source)throw problem('download_partial_asset_mismatch');
      if(meta.total!==undefined&&(!Number.isSafeInteger(meta.total)||meta.total<0||meta.total>maxBytes))throw problem('download_cache_metadata_invalid');
      if((meta.etag&&(!/^"[^\r\n]{1,500}"$/.test(meta.etag)))||(meta.lastModified&&(!Number.isFinite(Date.parse(meta.lastModified))||meta.lastModified.length>100)))throw problem('download_cache_metadata_invalid');
    }
    let bytes=regular(part)?.size||0,total=meta.total||0;
    if(bytes>maxBytes)throw problem('download_too_large');
    // Old releases left a raw .partial without metadata. Adopt it only under
    // the selected immutable digest; the entire result must still verify.
    writePrivate(metaFile,meta);
    if(bytes&&await hashFile(part,algorithm)===expected){fs.renameSync(part,dest);fs.rmSync(metaFile,{force:true});onProgress(bytes,bytes,{phase:'verified',attempt:0,maxAttempts,resumed:true});return dest;}
    dispatcher=proxyPort?new ProxyAgent('http://127.0.0.1:'+proxyPort):new Agent();
    let checksumRestarted=false;
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      bytes=regular(part)?.size||0;
      const start=bytes,clock=deadline(idleTimeoutMs,attemptTimeoutMs);let fd,r,consumed=false;
      const emit=(phase,extra={})=>onProgress(bytes,total,{phase,attempt,maxAttempts,resumed:start>0,...extra});
      try{
        emit(bytes?'resuming':'connecting');
        const headers=bytes?{range:`bytes=${bytes}-`,...(meta.etag||meta.lastModified?{'if-range':meta.etag||meta.lastModified}:{})}:{};
        // Resolve the original release URL on every attempt. Signed CDN URLs
        // can expire and are deliberately never persisted in cache metadata.
        r=await request(url,headers,dispatcher,clock,fetcher);
        if(r.status===416&&bytes){
          await r.body?.cancel();consumed=true;
          if(await hashFile(part,algorithm)===expected){fs.renameSync(part,dest);fs.rmSync(metaFile,{force:true});emit('verified');return dest;}
          if(!checksumRestarted){fs.truncateSync(part,0);bytes=0;checksumRestarted=true;meta={format:1,source};writePrivate(metaFile,meta);throw problem('download_partial_restarting',true);}
          throw problem('download_range_mismatch');
        }
        if(!r.ok)throw httpFailure(r.status);
        if(![200,206].includes(r.status))throw problem('download_response_invalid');
        if(r.headers.get('content-encoding')&&!['identity'].includes(r.headers.get('content-encoding')))throw problem('download_content_encoding_invalid');
        let responseLength=length(r.headers.get('content-length')),end;
        if(r.status===206){
          const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range')||'');
          if(!m||Number(m[1])!==bytes||Number(m[2])<bytes||Number(m[3])<=Number(m[2])||![m[1],m[2],m[3]].every(v=>Number.isSafeInteger(Number(v))))throw problem('download_range_mismatch');
          total=Number(m[3]);end=Number(m[2])+1;
          if(responseLength&&responseLength!==end-bytes)throw problem('download_range_mismatch');
        }else{
          // A 200 response to Range is a full replacement, never an append.
          bytes=0;total=responseLength;
        }
        if(total>maxBytes)throw problem('download_too_large');
        const etag=r.headers.get('etag'),lastModified=r.headers.get('last-modified');
        meta={format:1,source,total,...(etag&&/^"[^\r\n]{1,500}"$/.test(etag)?{etag}:{}),...(lastModified&&lastModified.length<=100&&Number.isFinite(Date.parse(lastModified))?{lastModified}:{})};
        writePrivate(metaFile,meta);regular(part);
        fd=fs.openSync(part,(r.status===206?fs.constants.O_APPEND:fs.constants.O_TRUNC)|fs.constants.O_CREAT|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0),0o600);
        let last=0;emit(start&&r.status===200?'restarting':'downloading');
        for await(const block of r.body){
          clock.idle();const b=Buffer.from(block);
          if(bytes+b.length>maxBytes||(total&&bytes+b.length>total))throw problem('download_too_large');
          writeAll(fd,b);bytes+=b.length;
          if(Date.now()-last>250){emit('downloading');last=Date.now();}
        }
        consumed=true;fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;clock.stop();
        if((end&&bytes!==end)||(total&&bytes!==total))throw problem('download_incomplete',true);
        emit('verifying');
        if(await hashFile(part,algorithm)!==expected){
          if(!checksumRestarted&&attempt<maxAttempts){fs.truncateSync(part,0);bytes=0;checksumRestarted=true;meta={format:1,source};writePrivate(metaFile,meta);throw problem('download_checksum_failed',true);}
          throw problem('download_checksum_failed');
        }
        fs.renameSync(part,dest);fs.rmSync(metaFile,{force:true});emit('verified');return dest;
      }catch(error){
        if(fd!==undefined){try{fs.closeSync(fd);}catch{}fd=undefined;}
        if(r?.body&&!consumed){try{await r.body.cancel();}catch{}}
        const failure=downloadFailure(error,{proxy:Boolean(proxyPort),signal:clock.signal});
        bytes=regular(part)?.size||0;
        const retry=failure.retryable&&attempt<maxAttempts,retryInMs=Math.min(1000*2**(attempt-1),15000);
        emit(retry?'retrying':'failed',{error:failure.message,...(retry?{retryInMs}:{})});
        if(!retry)throw failure;
        clock.stop();await wait(retryInMs);
      }finally{clock.stop();}
    }
    throw problem('download_retries_exhausted');
  }catch(e){throw downloadFailure(e,{proxy:Boolean(proxyPort)});}
  finally{try{if(dispatcher)await dispatcher.destroy();}finally{unlock?.();}}
}

export async function downloadChecksum(url,{proxyPort,fetcher=fetch,wait=sleep}={}){
  allowed(url);
  if(proxyPort!==undefined&&(!Number.isInteger(proxyPort)||proxyPort<1024||proxyPort>65535))throw problem('download_proxy_port_invalid');
  const dispatcher=proxyPort?new ProxyAgent('http://127.0.0.1:'+proxyPort):new Agent();
  try{
    for(let attempt=1;attempt<=3;attempt++){
      const clock=deadline(30000,60000);let response;
      try{
        response=await request(url,{},dispatcher,clock,fetcher);
        if(!response.ok)throw httpFailure(response.status);
        let text='';for await(const b of response.body){clock.idle();text+=Buffer.from(b).toString('utf8');if(text.length>4096)throw problem('download_checksum_invalid');}
        const value=text.trim().split(/\s+/)[0];if(!/^[a-f0-9]{128}$/.test(value))throw problem('download_checksum_invalid');return value;
      }catch(e){try{await response?.body?.cancel();}catch{}const failure=downloadFailure(e,{proxy:Boolean(proxyPort),signal:clock.signal});if(!failure.retryable||attempt===3)throw failure;clock.stop();await wait(1000*attempt);}
      finally{clock.stop();}
    }
  }finally{await dispatcher.destroy();}
}
