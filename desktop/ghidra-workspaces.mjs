import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile,lstat,copyFile,access,rm,cp,readdir,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';

export const GHIDRA_QUERIES=['program_info','functions','classes','namespaces','segments','imports','exports','data','strings','function','decompile','disassemble','xrefs_to','xrefs_from','function_xrefs','function_calls','read_memory'];
export const GHIDRA_EDITS=['rename_function','rename_data','rename_variable','set_comment','set_prototype','set_variable_type'];
const fields={address:{type:'string',maxLength:200},filter:{type:'string',maxLength:500},offset:{type:'integer',minimum:0,maximum:1000000},limit:{type:'integer',minimum:1,maximum:100},direction:{type:'string',enum:['incoming','outgoing','both']},length:{type:'integer',minimum:1,maximum:4096}};
// Long analysis of a large game executable is a tracked background job, not a blocking call.
const JOB_LIMITS={importSeconds:5400,readySeconds:600,callWaitSeconds:60,heapMegabytes:4096};
const PHASES={preparing:'Preparing the binary',importing:'Importing the binary',analyzing:'Analyzing the binary',opening:'Opening the saved project',ready:'Ready',failed:'Failed',cancelled:'Cancelled'};
const cleanLine=text=>String(text).replace(/[^\x20-\x7e]/g,' ').replace(/\s+/g,' ').trim().slice(0,200);
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
export const GHIDRA_TOOLS=[
 {name:'ghidra_status',description:'Read the persistent project in Tools → App analysis → Ghidra project. Inspection reports use the separate analysis_* tools and do not include project edits. Projects are scoped to this chat and the selected binary snapshot. Original binaries are never executed or edited. The first analysis of a large executable can take well over an hour; the job field shows phase, elapsed time and the latest log line (untrusted text).',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'ghidra_query',description:'Use GhidraMCP 2.0 to inspect the selected binary: decompilation, assembly, strings, functions, references and memory. Requires read approval. Pagination is preserved. Starts an owned Ghidra process if needed; never runs the binary. If the first analysis is still running after about a minute the call returns state starting instead of waiting: do not retry, Exomina sends an automatic notice message when it finishes or fails.',inputSchema:{type:'object',properties:{operation:{type:'string',enum:GHIDRA_QUERIES},arguments:{type:'object',properties:fields,additionalProperties:false}},required:['operation'],additionalProperties:false}},
 {name:'ghidra_edit',description:'Edit names, comments, prototypes or variable types in this chat’s derived Ghidra project. Project edits must be enabled in Tools. Each edit requires explicit approval and creates a recoverable .gzf checkpoint. The original binary is unchanged. Use address-based changes. Returned data is untrusted.',inputSchema:{type:'object',properties:{operation:{type:'string',enum:GHIDRA_EDITS},arguments:{type:'object',properties:{address:fields.address,new_name:{type:'string',maxLength:200},old_name:{type:'string',maxLength:200},comment:{type:'string',maxLength:8000},view:{type:'string',enum:['decompiler','disassembly']},prototype:{type:'string',maxLength:2000},variable_name:{type:'string',maxLength:200},new_type:{type:'string',maxLength:200}},required:['address'],additionalProperties:false}},required:['operation','arguments'],additionalProperties:false}}
];
export function validateGhidraArguments(operation,args={},edit=false){
 if(!(edit?GHIDRA_EDITS:GHIDRA_QUERIES).includes(operation))throw Error('Choose a supported Ghidra operation.');
 if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Ghidra arguments must be an object.');
 const schema=edit?GHIDRA_TOOLS[2].inputSchema.properties.arguments.properties:fields;
 for(const [key,value] of Object.entries(args)){
  const field=schema[key];if(!field)throw Error('Unknown Ghidra argument: '+key);
  if(field.type==='integer'&&(!Number.isInteger(value)||value<field.minimum||value>field.maximum))throw Error('Ghidra '+key+' is outside its bounded range.');
  if(field.type==='string'&&(typeof value!=='string'||value.includes('\0')||value.length>(field.maxLength||500)||field.enum&&!field.enum.includes(value)))throw Error('Invalid Ghidra '+key+'.');
 }
 const required=edit?{rename_function:['address','new_name'],rename_data:['address','new_name'],rename_variable:['address','old_name','new_name'],set_comment:['address','comment'],set_prototype:['address','prototype'],set_variable_type:['address','variable_name','new_type']}[operation]:['function','decompile','disassemble','xrefs_to','xrefs_from','function_xrefs','function_calls','read_memory'].includes(operation)?['address']:[];
 for(const key of required)if(typeof args[key]!=='string'||key!=='comment'&&!args[key].trim())throw Error('Ghidra '+key+' is required.');
 if(args.address&&!/^(?:0x)?[\da-f]+$/i.test(args.address))throw Error('Use a hexadecimal Ghidra address.');
 return structuredClone(args);
}
async function regular(file){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink>1)throw Error('Ghidra setup requires a regular, unlinked file.');return info;}

export class GhidraWorkspaces{
 constructor({dataDir,analysis,approve,getChat,save=async()=>{},emit=()=>{},runtimeRoot=fileURLToPath(new URL('..',import.meta.url)),installedSetup=null,notify=null,limits={}}){Object.assign(this,{dataDir,analysis,approve,getChat,save,emit,runtimeRoot,installedSetup,notify});this.limits={...JOB_LIMITS,...limits};this.jobs=new Map();this.sessions=new Map();this.starting=new Map();this.imports=new Map();this.closed=false;this.generation=new Map();}
 get definitions(){return GHIDRA_TOOLS;}
 status(id){const chat=this.getChat(id),session=this.sessions.get(id),saved=chat?.ghidraProject?.selectionId===chat?.analysisTarget?.selectionId?chat?.ghidraProject:null;return {version:'2.0.0',target:chat?.analysisTarget?{name:chat.analysisTarget.name,kind:chat.analysisTarget.kind}:null,editing:!!chat?.ghidraEditing,state:this.starting.has(id)?'starting':session&&!session.dead?'connected':'stopped',program:session?.program||saved?.program||null,sha256:session?.hash||saved?.sha256||null,project:session?.folder||saved?.project||null,job:this.jobView(id),queries:GHIDRA_QUERIES,edits:GHIDRA_EDITS};}
 jobView(id){
  const job=this.jobs.get(id);if(!job)return null;
  const end=job.finishedAt||Date.now();
  return {phase:job.phase,label:PHASES[job.phase]||job.phase,startedAt:new Date(job.startedAt).toISOString(),elapsedSeconds:Math.round((end-job.startedAt)/1000),active:!job.finishedAt,detail:job.detail||'',error:job.error||null,limitMinutes:Math.round(this.limits.importSeconds/60),notifiesWhenDone:!!job.wake};
 }
 setJob(id,patch){
  const job=this.jobs.get(id);if(!job||job.finishedAt)return;
  let changed=false;for(const key of Object.keys(patch))if(job[key]!==patch[key]){job[key]=patch[key];changed=true;}
  if(changed)this.emit({type:'ghidra.changed',conversationId:id});
 }
 finishJob(id,phase,error=null){
  const job=this.jobs.get(id);if(!job||job.finishedAt)return;
  Object.assign(job,{phase,finishedAt:Date.now(),error:error?String(error.message||error).slice(0,1500):null});
  const wake=job.wake&&phase!=='cancelled';job.wake=false;
  if(wake&&this.notify){
    const minutes=Math.max(1,Math.round((job.finishedAt-job.startedAt)/60000));
    const text=phase==='ready'?'[Exomina automatic notice] The Ghidra analysis you were waiting for finished after about '+minutes+' min and the project is ready. Continue with ghidra_query.':'[Exomina automatic notice] The Ghidra analysis you were waiting for failed after about '+minutes+' min: '+(job.error||'unknown error').slice(0,600)+' Check ghidra_status before retrying.';
    Promise.resolve().then(()=>this.notify(id,text)).catch(()=>{});
  }
 }
 async enableEditing(id,value){if(typeof value!=='boolean')throw Error('Choose whether to allow Ghidra project edits.');const chat=this.getChat(id);if(!chat)throw Error('Choose a chat.');chat.ghidraEditing=value;await this.save();this.emit({type:'ghidra.changed',conversationId:id});return this.status(id);}
 async nativeSetup(){
  const config=await this.analysis.nativeConfiguration(),patch={};
  for(const key of ['ghidraPath','javaPath'])if(!config[key]&&this.installedSetup?.[key]){
   try{await this.analysis.checkPath(this.installedSetup[key],{directory:true});patch[key]=this.installedSetup[key];}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(!Object.keys(patch).length)return config;
  // Persist only missing selections. The production dependency probe validates
  // these fixed app-owned installation paths; user-selected paths take priority.
  return this.analysis.configureNative(patch);
 }
 async install(config){
  if(!config.ghidraPath||!config.javaPath)throw Error('Choose Ghidra 12.1.4 and a full JDK under Tools → App analysis → Native analysis setup first.');
  await this.analysis.checkPath(config.ghidraPath,{directory:true});await this.analysis.checkPath(config.javaPath,{directory:true});
  const properties=await readFile(path.join(config.ghidraPath,'Ghidra','application.properties'),'utf8');if(!/^application.version=12\.1\.4\s*$/m.test(properties))throw Error('GhidraMCP 2.0 requires Ghidra 12.1.4.');
  const base=path.join(this.runtimeRoot,'vendor','ghidramcp','GhidraMCP'),dest=path.join(config.ghidraPath,'Ghidra','Extensions','GhidraMCP');
  // Only the hash-pinned bundled extension may be installed. Refuse an unrelated existing copy.
  for(const relative of ['extension.properties','Module.manifest','lib/GhidraMCP.jar']){
   const source=path.join(base,relative);await regular(source);const bytes=await readFile(source),file=path.join(dest,relative);if(relative==='lib/GhidraMCP.jar'&&createHash('sha256').update(bytes).digest('hex')!=='1d41bd86c33879f0e42658cd5e06bb57c5f3a128e5500dd76ab37b2b9db481f1')throw Error('Bundled GhidraMCP integrity check failed.');
   try{await regular(file);await this.analysis.checkPath(path.dirname(file),{directory:true});if(!bytes.equals(await readFile(file)))throw Error('A different GhidraMCP extension is already installed.');}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(path.dirname(file),{recursive:true});await this.analysis.checkPath(path.dirname(file),{directory:true});await copyFile(source,file);}
  }
 }
 start(id,{userAction=false}={}){
  if(this.starting.has(id))return this.starting.get(id);
  const generation=this.generation.get(id)||0;
  this.jobs.set(id,{phase:'preparing',startedAt:Date.now(),finishedAt:null,detail:'',error:null,wake:false});
  const promise=this.startNow(id,userAction,generation).then(()=>{this.starting.delete(id);this.finishJob(id,'ready');return this.status(id);},error=>{this.starting.delete(id);this.finishJob(id,(this.generation.get(id)||0)!==generation?'cancelled':'failed',error);throw error;}).finally(()=>{this.starting.delete(id);this.emit({type:'ghidra.changed',conversationId:id});});promise.catch(()=>{});this.starting.set(id,promise);this.emit({type:'ghidra.changed',conversationId:id});return promise;
 }
 async startNow(id,userAction,generation){
  if(this.closed)throw Error('Ghidra workspaces are closed.');
  const live=()=>{if(this.closed||(this.generation.get(id)||0)!==generation)throw Error('Ghidra start cancelled.');};
  const target=await this.analysis.target(id);if(target.kind!=='file'||!target.name.toLowerCase().endsWith('.exe'))throw Error('Choose a single Windows x86/x64 EXE with Choose file under Tools → App analysis, then open Ghidra project.');
  if(!userAction&&!await this.approve({title:'Read binary with GhidraMCP?',detail:target.path+'\nStart an owned Ghidra process and inspect a static copy. The binary is never executed.',conversationId:id,action:{kind:'read',tool:'ghidra_query',target:target.path}}))throw Error('Ghidra read was declined.');live();
  const bytes=await this.analysis.bytes(target.path,{expected:target.identity,max:256*1024*1024});live();
  await this.analysis.confirmTarget(id,target);
  const peOffset=bytes.length>=64?bytes.readUInt32LE(60):-1;if(bytes[0]!==77||bytes[1]!==90||peOffset<0||peOffset+6>bytes.length||bytes.readUInt32LE(peOffset)!==0x4550||![0x14c,0x8664].includes(bytes.readUInt16LE(peOffset+4)))throw Error('Choose a Windows x86 or x64 PE executable.');
  const hash=createHash('sha256').update(bytes).digest('hex'),existing=this.sessions.get(id);if(existing&&!existing.dead&&existing.hash===hash&&existing.target.selectionId===target.selectionId)return this.status(id);
  await this.stopSession(id);live();const config=await this.nativeSetup();live();await this.install(config);live();
  const folder=path.join(this.dataDir,'ghidra-workspaces',createHash('sha256').update(id).digest('hex'),hash),home=path.join(folder,'home'),checkpoints=path.join(folder,'checkpoints'),snapshot=path.join(folder,'target.exe');
  await mkdir(home,{recursive:true});await mkdir(checkpoints,{recursive:true});await writeFile(snapshot,bytes);live();
  const java=path.join(config.javaPath,'bin',process.platform==='win32'?'java.exe':'java'),utility=path.join(config.ghidraPath,'Ghidra','Framework','Utility','lib','Utility.jar');await regular(java);await regular(utility);
  const nonce=randomBytes(32).toString('hex'),prefix='EXOMINA_GHIDRA_'+nonce+':';
  // HotSpot's hsperfdata directory grants access to Everyone. Disable that
  // optional diagnostic output so it cannot weaken the private project ACLs.
  const args=['-Xmx'+this.limits.heapMegabytes+'M','-XX:-UsePerfData','-XX:ParallelGCThreads=2','-XX:CICompilerCount=2','-Djava.system.class.loader=ghidra.GhidraClassLoader','-Djava.awt.headless=true','-Duser.home='+home,'-Dghidra.extensions.classpath.restricted=false','-cp',utility,'ghidra.Ghidra','ghidra.app.util.headless.AnalyzeHeadless',folder,'Exomina'];
  const env={HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TEMP:home,TMP:home,EXOMINA_GHIDRA_NONCE:nonce,EXOMINA_GHIDRA_CHECKPOINTS:checkpoints};for(const key of ['SystemRoot','WINDIR'])if(process.env[key])env[key]=process.env[key];
  try{await access(path.join(folder,'Exomina.gpr'));}catch(error){
   if(error.code!=='ENOENT')throw error;
   // Import first: a newly imported program has no writable DomainFile until
   // AnalyzeHeadless saves it. The second process opens that saved project.
   live();this.setJob(id,{phase:'importing',detail:''});
   const seconds=this.limits.importSeconds,importer=spawn(java,[...args,'-import',snapshot,'-analysisTimeoutPerFile',String(Math.max(60,seconds-300)),'-log',path.join(folder,'import.log')],{cwd:folder,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});this.imports.set(id,importer);let diagnostic='',timedOut=false,lastDetail=0;
   const note=chunk=>{
    diagnostic=(diagnostic+chunk.toString()).slice(-6000);
    const now=Date.now();if(now-lastDetail<3000)return;
    const line=cleanLine(diagnostic.split(/\r?\n/).filter(text=>text.trim()).pop()||'');if(!line)return;
    lastDetail=now;this.setJob(id,{detail:line,...(/Analyzer\)|ANALYZING|Analysis/i.test(line)?{phase:'analyzing'}:{})});
   };
   for(const stream of [importer.stdout,importer.stderr]){stream.on('data',note);stream.on('error',()=>importer.kill());}
   const timer=setTimeout(()=>{timedOut=true;importer.kill();},seconds*1000);
   try{
    const code=await new Promise((resolve,reject)=>{importer.once('error',reject);importer.once('close',resolve);});
    live();if(timedOut)throw Error('Ghidra analysis did not finish within '+Math.round(seconds/60)+' minutes and was stopped. Nothing partial was kept.');
    if(code!==0)throw Error('Ghidra import failed. '+diagnostic.slice(-2000));await access(path.join(folder,'Exomina.gpr'));
   }catch(error){await this.discardProject(folder);throw error;}finally{clearTimeout(timer);this.imports.delete(id);}live();await this.analysis.confirmTarget(id,target);
  }
  live();this.setJob(id,{phase:'opening',detail:''});
  args.push('-process',...(await this.adopted(folder)?[]:['target.exe']),'-noanalysis','-scriptPath',path.join(this.runtimeRoot,'desktop','ghidra'),'-postScript','ExominaGhidra.java','-log',path.join(folder,'ghidra.log'),'-scriptlog',path.join(folder,'script.log'));
  live();const child=spawn(java,args,{cwd:folder,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const session={child,folder,hash,target,nonce,prefix,pending:new Map(),nextId:1,dead:false,buffer:'',errors:'',program:null};this.sessions.set(id,session);
  const ready=new Promise((resolve,reject)=>session.pending.set(0,{resolve,reject,timer:setTimeout(()=>{reject(Error('Ghidra project did not open within '+Math.round(this.limits.readySeconds/60)+' minutes.'));child.kill();},this.limits.readySeconds*1000)}));
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{session.buffer+=chunk;if(session.buffer.length>2*1024*1024){this.fail(session,Error('Ghidra response exceeds 2 MB.'));child.kill();return;}let newline;while((newline=session.buffer.indexOf('\n'))>=0){const line=session.buffer.slice(0,newline);session.buffer=session.buffer.slice(newline+1);if(!line.startsWith(prefix))continue;try{const message=JSON.parse(line.slice(prefix.length)),request=session.pending.get(message.id);if(!request)continue;clearTimeout(request.timer);session.pending.delete(message.id);message.error?request.reject(Error(message.error)):request.resolve(message);}catch{this.fail(session,Error('Invalid Ghidra response.'));child.kill();}}});
  child.stderr.on('data',chunk=>{session.errors=(session.errors+chunk.toString()).slice(-6000);});for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',error=>this.fail(session,error));child.on('error',error=>this.fail(session,error));child.on('close',code=>{this.fail(session,Error('Ghidra stopped ('+code+'). '+session.errors.slice(-2000)));this.emit({type:'ghidra.changed',conversationId:id});});
  try{const message=await ready;live();if(message.executableSha256&&message.executableSha256.toLowerCase()!==hash){await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill();});await this.discardProject(folder);await rm(path.join(folder,'adopted.json'),{force:true});throw Error('This Ghidra project was built from a different binary than the selected EXE. It was not kept.');}await this.analysis.confirmTarget(id,target);session.program=message.result;await writeFile(path.join(folder,'provenance.json'),JSON.stringify({sha256:hash,source:target.name,ghidra:'12.1.4',ghidramcp:'2.0.0'},null,2));this.getChat(id).ghidraProject={selectionId:target.selectionId,program:session.program,sha256:hash,project:folder};await this.save();return this.status(id);}catch(error){child.kill();this.fail(session,error);throw error;}
 }
 async adopted(folder){try{await access(path.join(folder,'adopted.json'));return true;}catch{return false;}}
 /** A half-finished import must never be reopened as if it were a complete analysis. */
 async discardProject(folder){for(const name of ['Exomina.gpr','Exomina.rep','Exomina.lock','Exomina.lock~'])await rm(path.join(folder,name),{recursive:true,force:true}).catch(()=>{});}
 /** Reuses a project that was analysed outside Exomina (for example a headless run with no time limit) for the selected EXE. */
 async adopt(id,gprFile){
  if(this.starting.has(id)||this.sessions.get(id))throw Error('Stop the Ghidra project before using another one.');
  const target=await this.analysis.target(id);if(target.kind!=='file'||!target.name.toLowerCase().endsWith('.exe'))throw Error('Choose a single Windows EXE first.');
  if(typeof gprFile!=='string'||!/\.gpr$/i.test(gprFile))throw Error('Choose a Ghidra project file (.gpr).');
  const source=path.dirname(gprFile),name=path.basename(gprFile).slice(0,-4);await regular(gprFile);
  const entries=await readdir(source);if(entries.some(entry=>entry.toLowerCase()===name.toLowerCase()+'.lock'))throw Error('That project is still open or did not close cleanly. Wait for its Ghidra run to finish first.');
  if(!(await lstat(path.join(source,name+'.rep')).catch(()=>null))?.isDirectory())throw Error('The project data folder '+name+'.rep is missing next to the .gpr file.');
  const bytes=await this.analysis.bytes(target.path,{expected:target.identity,max:256*1024*1024}),hash=createHash('sha256').update(bytes).digest('hex');
  const folder=path.join(this.dataDir,'ghidra-workspaces',createHash('sha256').update(id).digest('hex'),hash);
  if(await access(path.join(folder,'Exomina.gpr')).then(()=>true,()=>false)){
   /* An earlier project (often a partial import from a run that hit the old time limits) is set aside, not deleted, so any edits in it stay recoverable. */
   const backup=path.join(folder,'replaced-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(backup,{recursive:true});
   for(const entry of ['Exomina.gpr','Exomina.rep','Exomina.lock','Exomina.lock~'])await rename(path.join(folder,entry),path.join(backup,entry)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  await mkdir(path.join(folder,'home'),{recursive:true});await mkdir(path.join(folder,'checkpoints'),{recursive:true});await writeFile(path.join(folder,'target.exe'),bytes);
  try{await copyFile(gprFile,path.join(folder,'Exomina.gpr'));await cp(path.join(source,name+'.rep'),path.join(folder,'Exomina.rep'),{recursive:true,errorOnExist:true,force:false});await writeFile(path.join(folder,'adopted.json'),JSON.stringify({from:gprFile,sha256:hash}));}catch(error){await this.discardProject(folder);throw error;}
  this.emit({type:'ghidra.changed',conversationId:id});return this.status(id);
 }
 fail(session,error){session.dead=true;for(const pending of session.pending.values()){clearTimeout(pending.timer);pending.reject(error);}session.pending.clear();}
 request(session,operation,args={},edit=false){if(session.dead)throw Error('Ghidra disconnected. Inspect the project before retrying.');return new Promise((resolve,reject)=>{const id=session.nextId++,timer=setTimeout(()=>{session.pending.delete(id);reject(Error('Ghidra timed out. The project change may have completed; read its state before retrying.'));session.child.kill();},90000);session.pending.set(id,{resolve,reject,timer});session.child.stdin.write(JSON.stringify({id,nonce:session.nonce,operation,arguments:args,edit})+'\n',error=>{if(error)this.fail(session,error);});});}
 async call(name,args={},id){
  if(name==='ghidra_status')return result(this.status(id));
  const edit=name==='ghidra_edit';if(!edit&&name!=='ghidra_query')throw Error('Unknown Ghidra tool.');
  const parameters=validateGhidraArguments(args.operation,args.arguments,edit);
  if(edit&&!this.getChat(id)?.ghidraEditing)throw Error('Enable project edits under Tools → App analysis → Ghidra project first.');
  const pending=await this.startOrReport(id);if(pending)return result(pending);const session=this.sessions.get(id),target=await this.analysis.confirmTarget(id,session.target);
  if(edit){if(!await this.approve({title:'Apply Ghidra project edit?',detail:`Project: ${session.folder}\nBinary SHA-256: ${session.hash}\nOperation: ${args.operation}\n${JSON.stringify(parameters,null,2)}\nA .gzf checkpoint will be saved first.`,conversationId:id,requireConfirmation:true,action:{kind:'write',tool:'ghidra_edit',target:target.path}}))throw Error('Ghidra edit was declined.');if(!this.getChat(id)?.ghidraEditing||this.sessions.get(id)!==session||session.dead)throw Error('Ghidra scope changed during approval.');await this.analysis.confirmTarget(id,session.target);}
  const message=await this.request(session,args.operation,parameters,edit);return result({sha256:session.hash,program:session.program,operation:args.operation,...message,id:undefined});
 }
 /** Waits briefly for a start; a long analysis keeps running in the background and the model is told how to follow it. */
 async startOrReport(id){
  const started=this.start(id),wait=new Promise(resolve=>{const timer=setTimeout(()=>resolve('running'),this.limits.callWaitSeconds*1000);timer.unref?.();started.then(()=>clearTimeout(timer),()=>clearTimeout(timer));});
  if(await Promise.race([started.then(()=>'ready'),wait])==='ready')return null;
  const job=this.jobs.get(id);if(job&&!job.finishedAt)job.wake=true;
  return {state:'starting',message:'Ghidra analysis is still running in the background; it has not hung. Do not retry ghidra_query now. Exomina will send an automatic notice when it finishes or fails. Use ghidra_status to see the phase and elapsed time.',job:this.jobView(id)};
 }
 async stopSession(id){const session=this.sessions.get(id);if(!session)return;this.sessions.delete(id);if(session.dead)return;if(!session.program){session.child.kill();return;}try{await this.request(session,'close');session.child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{session.child.kill();resolve();},5000);session.child.once('close',()=>{clearTimeout(timer);resolve();});});}catch{session.child.kill();}}
 async stop(id){this.generation.set(id,(this.generation.get(id)||0)+1);const starting=this.starting.get(id);this.imports.get(id)?.kill();await this.stopSession(id);await starting?.catch(()=>{});this.emit({type:'ghidra.changed',conversationId:id});return this.status(id);}
 async close(){this.closed=true;await Promise.all([...new Set([...this.sessions.keys(),...this.starting.keys()])].map(id=>this.stop(id)));}
}
