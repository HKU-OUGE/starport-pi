import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {processCall,sshArgs} from './transport.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function installRemote(config,root,archive,{cpus=4,memoryGiB=8,cpuIndices,runscRemote,runscSha256,onProgress=()=>{}}={}) {
  if(!Number.isInteger(cpus)||cpus<1||cpus>512||!Number.isInteger(memoryGiB)||memoryGiB<2||memoryGiB>4096)throw new Error('invalid_server_budget');
  const server=config.servers[config.activeServer];if(!server)throw new Error('select_server_first');
  const args=sshArgs(config.activeServer,server,root);const staging=crypto.randomBytes(12).toString('hex');
  const files=Object.fromEntries(['install.py','worker.py','configure_gpu.py'].map(name=>[name,fs.readFileSync(path.join(repository,'server',name)).toString('base64')]));
  const script=`import pathlib,base64,json\np=pathlib.Path.home()/'.cache/starport-pi-install'/${JSON.stringify(staging)}\np.mkdir(parents=True,mode=0o700)\nfiles=json.loads(${JSON.stringify(JSON.stringify(files))})\nfor name,data in files.items():(p/name).write_bytes(base64.b64decode(data))\nprint('ready')\n`;
  await processCall('ssh',[...args,'python3 -I -'],script);
  const stat=fs.lstatSync(archive);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('regular_archive_required');
  const hash=crypto.createHash('sha256');for await(const data of fs.createReadStream(archive))hash.update(data);const checksum=hash.digest('hex');
  await new Promise((resolve,reject)=>{
    const child=spawn('ssh',[...args,`cat > "$HOME/.cache/starport-pi-install/${staging}/rootfs.tar"`],{stdio:['pipe','ignore','pipe'],windowsHide:true,shell:false});
    let sent=0;const input=fs.createReadStream(archive);input.on('data',b=>{sent+=b.length;onProgress(sent,stat.size);});input.on('error',reject);
    child.stderr.resume();child.on('error',()=>reject(new Error('upload_failed')));child.stdin.on('error',()=>{});
    child.on('close',code=>{input.destroy();code===0?resolve():reject(new Error('upload_failed'));});input.pipe(child.stdin);
  });
  let extra='';
  if(cpuIndices){if(!Array.isArray(cpuIndices)||cpuIndices.length!==cpus||cpuIndices.some(v=>!Number.isInteger(v)||v<0))throw new Error('invalid_cpu_indices');extra+=' --cpu-indices '+cpuIndices.join(',');}
  if(runscRemote){
    if(typeof runscRemote!=='string'||/[\r\n\0]/.test(runscRemote)||!/^[a-f0-9]{64}$/.test(runscSha256||''))throw new Error('invalid_runtime_source');
    extra+=" --runsc '"+runscRemote.replaceAll("'","'\\''")+"' --runsc-sha256 "+runscSha256;
  }
  const command=`python3 -I "$HOME/.cache/starport-pi-install/${staging}/install.py" --rootfs "$HOME/.cache/starport-pi-install/${staging}/rootfs.tar" --sha256 ${checksum} --cpus ${cpus} --memory-gib ${memoryGiB}${extra}`;
  const result=JSON.parse(await processCall('ssh',[...args,command],'',{timeout:600000}));
  // Only the staging directory created by this operation is eligible for removal.
  await processCall('ssh',[...args,`python3 -I -c 'import pathlib,shutil;shutil.rmtree(pathlib.Path.home()/".cache/starport-pi-install"/"${staging}")'`],'');
  return result;
}
