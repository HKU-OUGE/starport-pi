import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function upload(remote,localFile,remotePath,{progress=()=>{},resumeFile}={}) {
  const st=fs.lstatSync(localFile);if(st.isSymbolicLink()||!st.isFile())throw new Error('regular_file_required');
  const hash=crypto.createHash('sha256');for await(const b of fs.createReadStream(localFile))hash.update(b);
  const sha256=hash.digest('hex');let grant;
  if(resumeFile&&fs.existsSync(resumeFile)) {
    grant=JSON.parse(fs.readFileSync(resumeFile,'utf8'));
    if(grant.sha256!==sha256||grant.bytes!==st.size||grant.path!==remotePath)throw new Error('upload_resume_mismatch');
  } else {
    const result=await remote.call('upload.begin',{path:remotePath,bytes:st.size,sha256});
    grant={...result,path:remotePath,bytes:st.size,sha256};
  }
  const persist=()=>{if(resumeFile)fs.writeFileSync(resumeFile,JSON.stringify(grant),{mode:0o600});};persist();
  const file=await fs.promises.open(localFile,'r');
  try{
    while(grant.offset<st.size){
      const block=Buffer.alloc(Math.min(1024*1024,st.size-grant.offset));const {bytesRead}=await file.read(block,0,block.length,grant.offset);
      if(bytesRead!==block.length)throw new Error('source_changed');
      const result=await remote.call('upload.chunk',{upload:grant.id,offset:grant.offset,data:block.toString('base64'),sha256:crypto.createHash('sha256').update(block).digest('hex')});
      grant.offset=result.offset;persist();progress(grant.offset,st.size);
    }
  }finally{await file.close();}
  const result=await remote.call('upload.finish',{upload:grant.id});
  if(result.sha256!==sha256)throw new Error('upload_checksum');
  if(resumeFile)fs.rmSync(resumeFile,{force:true});return result;
}
export async function download(remote,job,remotePath,localFile,{progress=()=>{}}={}) {
  const temporary=localFile+'.partial';fs.mkdirSync(path.dirname(localFile),{recursive:true});
  if(fs.existsSync(temporary)&&fs.lstatSync(temporary).isSymbolicLink())throw new Error('destination_is_link');
  const file=await fs.promises.open(temporary,'w',0o600);let offset=0;let version;const hash=crypto.createHash('sha256');
  try{
    while(true){
      const row=await remote.call('artifact.read',{job,path:remotePath,offset,size:1024*1024,...(version?{version}:{})});
      version=row.version;
      const bytes=Buffer.from(row.data,'base64');
      if(row.offset!==offset||bytes.length!==row.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new Error('download_checksum');
      await file.write(bytes);hash.update(bytes);offset+=bytes.length;progress(offset,row.total);
      if(offset===row.total)break;if(!bytes.length||offset>row.total)throw new Error('download_incomplete');
    }
  }finally{await file.close();}
  await fs.promises.rename(temporary,localFile);return {bytes:offset,sha256:hash.digest('hex')};
}
