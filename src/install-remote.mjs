import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {processCall,sshArgs} from './transport.mjs';
import {privateDir,writePrivate} from './config.mjs';
import {ProxyAgent} from 'undici';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function downloadRuntime(config,root,architecture) {
  if(!['x86_64','aarch64'].includes(architecture)||config.proxy.mode!=='required')throw new Error('unsupported_server_architecture');
  const version='20261026.0';
  const dir=privateDir(path.join(root,'install-cache'));const archive=path.join(dir,`gvisor-${version}-${architecture}.tar.bz2`);
  const url=`https://storage.googleapis.com/gvisor/releases/release/${version}/${architecture}/gvisor.tar.bz2`;
  const proxy=new ProxyAgent(`http://127.0.0.1:${config.proxy.port}`);
  let output;
  try{
    const response=await fetch(url+'.sha512',{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('runtime_checksum_download_failed');
    const expected=(await response.text()).trim().split(/\s+/)[0];
    if(!/^[a-f0-9]{128}$/.test(expected))throw new Error('runtime_checksum_invalid');
    if(fs.existsSync(archive)){
      const hash=crypto.createHash('sha512');for await(const b of fs.createReadStream(archive))hash.update(b);
      if(hash.digest('hex')===expected)return archive;
      throw new Error('runtime_cache_checksum_failed');
    }
    const r=await fetch(url,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(300000)});
    if(!r.ok)throw new Error('runtime_download_failed');
    const temporary=archive+'.partial';
    if(fs.existsSync(temporary)&&fs.lstatSync(temporary).isSymbolicLink())throw new Error('invalid_install_cache');
    output=fs.openSync(temporary,'w',0o600);const hash=crypto.createHash('sha512');let total=0;
    for await(const data of r.body){total+=data.length;if(total>256*1024*1024)throw new Error('runtime_archive_too_large');hash.update(data);fs.writeSync(output,data);}
    fs.closeSync(output);output=undefined;
    if(hash.digest('hex')!==expected)throw new Error('runtime_download_checksum');
    fs.renameSync(temporary,archive);writePrivate(archive+'.receipt.json',{version,architecture,sha512:expected,bytes:total});
    return archive;
  }finally{if(output!==undefined)fs.closeSync(output);await proxy.close();}
}

async function sendArchive(args,archive,destination,onProgress) {
  const stat=fs.lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('regular_archive_required');
  const hash=crypto.createHash('sha256');for await(const data of fs.createReadStream(archive))hash.update(data);const checksum=hash.digest('hex');
  await new Promise((resolve,reject)=>{
    const child=spawn('ssh',[...args,`cat > "${destination}"`],{stdio:['pipe','ignore','pipe'],windowsHide:true,shell:false});
    const input=fs.createReadStream(archive);let sent=0;
    const timer=setTimeout(()=>{input.destroy();child.kill();reject(new Error('upload_timeout'));},30*60000);
    input.on('data',b=>{sent+=b.length;onProgress(sent,stat.size);});input.on('error',()=>{child.kill();reject(new Error('upload_failed'));});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);input.destroy();reject(new Error('upload_failed'));});child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timer);input.destroy();code===0?resolve():reject(new Error('upload_failed'));});input.pipe(child.stdin);
  });return checksum;
}
export async function installRemote(config,root,archive,{cpus=4,memoryGiB=8,cpuIndices,runscRemote,runscSha256,onProgress=()=>{}}={}) {
  if(!Number.isInteger(cpus)||cpus<1||cpus>512||!Number.isInteger(memoryGiB)||memoryGiB<2||memoryGiB>4096)throw new Error('invalid_server_budget');
  const server=config.servers[config.activeServer];if(!server)throw new Error('select_server_first');
  const args=sshArgs(config.activeServer,server,root);const staging=crypto.randomBytes(12).toString('hex');
  const files=Object.fromEntries(['install.py','worker.py','configure_gpu.py'].map(name=>[name,fs.readFileSync(path.join(repository,'server',name)).toString('base64')]));
  const script=`import pathlib,base64,json\np=pathlib.Path.home()/'.cache/starport-pi-install'/${JSON.stringify(staging)}\np.mkdir(parents=True,mode=0o700)\nfiles=json.loads(${JSON.stringify(JSON.stringify(files))})\nfor name,data in files.items():(p/name).write_bytes(base64.b64decode(data))\nprint('ready')\n`;
  await processCall('ssh',[...args,'python3 -I -'],script);
  let runtimeExtra='';
  if(!runscRemote){
    const architecture=(await processCall('ssh',[...args,'python3 -I -c "import platform;print(platform.machine())"'],'')).toString().trim();
    const runtime=await downloadRuntime(config,root,architecture);
    const runtimeHash=await sendArchive(args,runtime,`$HOME/.cache/starport-pi-install/${staging}/runtime.tar.bz2`,onProgress);
    runtimeExtra=` --runtime-archive "$HOME/.cache/starport-pi-install/${staging}/runtime.tar.bz2" --runtime-sha256 ${runtimeHash}`;
  }
  const checksum=await sendArchive(args,archive,`$HOME/.cache/starport-pi-install/${staging}/rootfs.tar`,onProgress);
  let extra='';
  if(cpuIndices){if(!Array.isArray(cpuIndices)||cpuIndices.length!==cpus||cpuIndices.some(v=>!Number.isInteger(v)||v<0))throw new Error('invalid_cpu_indices');extra+=' --cpu-indices '+cpuIndices.join(',');}
  if(runscRemote){
    if(typeof runscRemote!=='string'||/[\r\n\0]/.test(runscRemote)||!/^[a-f0-9]{64}$/.test(runscSha256||''))throw new Error('invalid_runtime_source');
    extra+=" --runsc '"+runscRemote.replaceAll("'","'\\''")+"' --runsc-sha256 "+runscSha256;
  }
  const command=`python3 -I "$HOME/.cache/starport-pi-install/${staging}/install.py" --rootfs "$HOME/.cache/starport-pi-install/${staging}/rootfs.tar" --sha256 ${checksum} --cpus ${cpus} --memory-gib ${memoryGiB}${extra}${runtimeExtra}`;
  const result=JSON.parse(await processCall('ssh',[...args,command],'',{timeout:600000}));
  // Only the staging directory created by this operation is eligible for removal.
  await processCall('ssh',[...args,`python3 -I -c 'import pathlib,shutil;shutil.rmtree(pathlib.Path.home()/".cache/starport-pi-install"/"${staging}")'`],'');
  return result;
}
