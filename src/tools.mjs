import {Type} from 'typebox';

const text=value=>({content:[{type:'text',text:JSON.stringify(value,null,2)}],details:{}});
const p=Type.String({minLength:1,maxLength:1024});
const job=Type.String({pattern:'^[a-f0-9]{32}$'});
const schema=properties=>Type.Object(properties,{additionalProperties:false});
export function makeTools(remote) {
  const tool=(name,description,parameters,operation,map=x=>x)=>({name,label:name,description,parameters,
    async execute(_id,args,signal){try{return text(await remote.call(operation,map(args),{signal}));}catch(e){return {...text({error:e.message}),isError:true};}}});
  return [
    {name:'server_status',label:'Server',description:'Read the selected server capacity and regional profile.',parameters:schema({}),
      async execute(){const r=await remote.call('health');return text({ready:r.ready,cpus:r.cpus,memory_gib:r.memory_gib,gpus:r.gpus,region:r.region,network_ready:r.egress_ready});}},
    tool('read','Read a UTF-8 project file. Paths are relative to /workspace.',schema({path:p}),'file.read',x=>({...x,size:2*1024*1024})),
    tool('write','Write a UTF-8 project file in the remote workspace.',schema({path:p,content:Type.String({maxLength:2*1024*1024})}),'file.write'),
    tool('list','List files in the remote project.',schema({path:Type.Optional(p)}),'file.list'),
    {name:'bash',label:'Remote command',description:'Start a shell command on the selected isolated server. Returns a job ID immediately; use job_status and job_logs. No local shell is available.',
      parameters:schema({command:Type.String({minLength:1,maxLength:131072}),cpus:Type.Optional(Type.Integer({minimum:1,maximum:512})),memory_gib:Type.Optional(Type.Integer({minimum:1,maximum:2048})),gpus:Type.Optional(Type.Integer({minimum:0,maximum:8})),timeout:Type.Optional(Type.Integer({minimum:1,maximum:86400})),datasets:Type.Optional(Type.Array(job,{maxItems:16}))}),
      async execute(_id,args,signal){try{return text(await remote.call('job.submit',args,{signal}));}catch(e){return {...text({error:e.message}),isError:true};}}},
    tool('job_status','Read computation state and confirmed resource release.',schema({job}),'job.status'),
    tool('job_logs','Read incremental UTF-8 logs. Reuse the returned byte cursor.',schema({job,cursor:Type.Optional(Type.Integer({minimum:0}))}),'job.logs'),
    tool('job_cancel','Cancel only the specified job in this workspace.',schema({job}),'job.cancel'),
    tool('artifacts','List files in a job output directory, including running jobs.',schema({job}),'job.artifacts'),
    tool('artifact_read','Read a bounded result-file chunk; bytes are base64 with SHA-256.',schema({job,path:p,offset:Type.Optional(Type.Integer({minimum:0})),size:Type.Optional(Type.Integer({minimum:1,maximum:2*1024*1024}))}),'artifact.read'),
    tool('datasets','List published immutable datasets.',schema({}),'dataset.list'),
    tool('dataset_publish','Publish a remote project directory as a new read-only dataset version.',schema({path:p}),'dataset.publish'),
  ];
}

export function decodeRead(tool) {
  const original=tool.execute;
  tool.execute=async(...args)=>{
    const result=await original(...args);
    if(result.isError)return result;
    const data=JSON.parse(result.content[0].text);
    if(data.total>2*1024*1024)return text({error:'file_too_large_use_remote_command'});
    return {content:[{type:'text',text:Buffer.from(data.data,'base64').toString('utf8')}],details:{}};
  };return tool;
}
