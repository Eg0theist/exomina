import path from 'node:path';
import {readFile,writeFile,mkdir,rename,lstat,realpath,readdir,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {featurePanelSource} from './feature-panel.mjs';
import {assertDiskSpace,WRITE_RESERVE_BYTES} from './disk-guard.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const inside=(root,file)=>{const relative=path.relative(root,file);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
const idPattern=/^[a-z][a-z0-9_-]{0,29}$/;
const cleanLabel=value=>typeof value==='string'&&!/[\p{Cc}\p{Cf}]/u.test(value);
const validId=value=>typeof value==='string'&&idPattern.test(value)&&!['constructor','prototype','__proto__'].includes(value)&&!/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(value);
async function json(file,fallback){try{const info=await lstat(file);if(info.isSymbolicLink()||info.size>512*1024)throw Error('Feature metadata must be a regular file smaller than 512 KiB.');return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
async function atomic(file,value){await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2),{encoding:'utf8',mode:0o600});await rename(temporary,file);}
export function validateFeatureManifest(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!validId(value.id))throw Error('Use a feature ID with up to 30 lowercase letters, numbers, dashes or underscores. Reserved names are excluded.');
  if(value.apiVersion!==1)throw Error('This feature needs a different Exomina feature API. Supported: 1.');
  if(!/^\d+\.\d+\.\d+$/.test(value.version||''))throw Error('Give the feature a numeric major.minor.patch version.');
  for(const key of ['name','description'])if(!cleanLabel(value[key])||!value[key].trim()||value[key].length>(key==='name'?60:500))throw Error('Give the feature a short single-line name and description without control characters.');
  if(value.worker!==undefined&&(!/\.(?:mjs|cjs|js)$/.test(value.worker)||value.worker.length>180))throw Error('A trusted worker must be a local JavaScript file.');
  if(value.panel!==undefined&&(typeof value.panel!=='string'||!value.panel.endsWith('.html')||value.panel.length>180))throw Error('A panel must be a local HTML file.');
  if(!value.worker&&!value.panel)throw Error('A feature needs a worker or panel.');
  if(value.worker&&value.trust!=='trusted-node')throw Error('Node workers must declare trust: trusted-node. They run with your account permissions.');
  const settings=value.settings||[];
  if(!Array.isArray(settings)||settings.length>20||settings.some(field=>!field||!validId(field.key)||!['string','boolean','number'].includes(field.type)||!cleanLabel(field.label)||field.label.length>80)||new Set(settings.map(field=>field.key)).size!==settings.length)throw Error('Use at most 20 uniquely named string, boolean or number settings.');
  if(value.dataVersion!==undefined&&(!Number.isInteger(value.dataVersion)||value.dataVersion<1))throw Error('Use a positive integer dataVersion.');
  return {id:value.id,name:value.name.trim(),description:value.description.trim(),version:value.version,apiVersion:1,dataVersion:value.dataVersion||1,...(value.worker?{worker:value.worker,trust:'trusted-node'}:{}),...(value.panel?{panel:value.panel}:{}),settings:settings.map(({key,label,type})=>({key,label,type}))};
}
export const FEATURE_PACKAGE_TOOL={name:'feature_package',description:'Build a feature in chat without restarting Exomina. Use prepare with self-contained UTF-8 files [{name,text}], including exomina-feature.json, to show a rendered preview and Enable button in this chat. No files are written or code run by prepare. Manifest API: {id,name,description,version:"1.0.0",apiVersion:1,panel:"panel.html",settings:[]}; optional worker:"worker.mjs" requires trust:"trusted-node" and speaks MCP stdio. Panels are static sanitized HTML with inline CSS, no scripts, forms, navigation or network. Put actions in a worker. For revisions, source reads the approved package by id or this chat’s previewId, then prepare a complete new version with the same id/dataVersion. Do not activate merely to show a preview; let the user review and enable it. Activation requires the exact previewId and approval; rollback restores the previous code while retaining data. Trusted Node workers run with full account permissions, not in an OS sandbox. preview also accepts a local package path. Never claim a preview is enabled.',inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{enum:['list','prepare','source','preview','activate','disable','enable','rollback','remove','discard']},files:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['name','text'],properties:{name:{type:'string'},text:{type:'string'}}}},path:{type:'string'},previewId:{type:'string'},id:{type:'string'}}}};

function describeFiles(files,root){
  files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  const manifestFile=files.find(file=>file.name==='exomina-feature.json');
  if(!manifestFile||manifestFile.data.length>32000)throw Error('Include a bounded exomina-feature.json manifest.');
  const manifest=validateFeatureManifest(JSON.parse(manifestFile.data.toString('utf8')));
  for(const file of [manifest.worker,manifest.panel].filter(Boolean))if(!files.some(item=>item.name===file))throw Error('Manifest entry files must be inside the package, with forward slash paths.');
  if(manifest.panel&&files.find(file=>file.name===manifest.panel).data.length>128*1024)throw Error('Feature panels must fit within 128 KiB.');
  if(files.map(file=>file.name+' '+file.sha256).join('\n').length+JSON.stringify(root).length>19000)throw Error('The complete package inventory must fit in its approval preview. Use fewer files or shorter paths.');
  return {root,manifest,files,digest:hash(JSON.stringify(files.map(({name,sha256})=>({name,sha256})))),bytes:files.reduce((sum,file)=>sum+file.data.length,0)};
}
function preparedFiles(input){
  if(!Array.isArray(input)||!input.length||input.length>100||Buffer.byteLength(JSON.stringify(input),'utf8')>512*1024)throw Error('Prepare at most 100 UTF-8 files and 512 KiB of encoded text.');
  const names=new Set(),directories=new Set(),files=input.map(file=>{
    if(!file||typeof file.name!=='string'||typeof file.text!=='string'||file.name.length>180||!file.name.split('/').every(part=>/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)&&!/[. ]$/.test(part)&&!/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part)))throw Error('Use relative package file names with forward slashes, without hidden files, links or reserved names.');
    const parts=file.name.split('/');if(parts.length>12||parts.some(part=>part.toLowerCase()==='node_modules'))throw Error('Use a self-contained package with at most 12 nested levels.');
    const key=file.name.toLowerCase();if(names.has(key))throw Error('Package file names must be unique, including letter case.');names.add(key);
    for(let i=1;i<parts.length;i++)directories.add(parts.slice(0,i).join('/').toLowerCase());
    const data=Buffer.from(file.text,'utf8');return {name:file.name,data,sha256:hash(data)};
  });
  if(directories.size>100||[...names].some(name=>directories.has(name)))throw Error('Package files and directories overlap or exceed their limit.');return files;
}

/** Immutable generations and a separate stable data directory. No npm hooks,
 * dependency installation, arbitrary entry command or automatic file watching. */
export class FeaturePackages{
  constructor({root,approve,exclude=async()=>{},getServers,saveServers,external,idle=()=>true,changed=()=>{},check=()=>{},command=process.execPath}){Object.assign(this,{root,approve,exclude,getServers,saveServers,external,idle,changed,check,command});this.records=Object.create(null);this.previews=new Map();this.revisions=new Map();this.queue=Promise.resolve();this.persistence=Promise.resolve();}
  async init(){
    try{
      await mkdir(this.root,{recursive:true});
      const registry=await json(path.join(this.root,'registry.json'),{});
      if(!registry||typeof registry!=='object'||Array.isArray(registry))throw Error('Invalid feature registry.');
      this.unreadRecords=Object.create(null);
      for(const[id,record]of Object.entries(registry)){try{const manifest=validateFeatureManifest(record.manifest);if(manifest.id!==id||!validId(id)||!/^[-a-f0-9]{36}$/.test(record.generation)||!/^[a-f0-9]{64}$/.test(record.digest)||typeof record.enabled!=='boolean')throw Error('Invalid record.');this.records[id]={...record,manifest};}catch{this.unreadRecords[id]=record;this.warning='An invalid feature registration was kept for recovery and was not started. Reinstall it from a reviewed package.';}}
      const servers=this.getServers().filter(server=>!server.featurePackage);for(const record of Object.values(this.records))if(record.manifest.worker)servers.push(this.config(record));
      if(JSON.stringify(servers)!==JSON.stringify(this.getServers()))await this.saveServers(servers);
    }catch(error){this.warning='Feature packages are unavailable: '+error.message;this.records=Object.create(null);this.loadError=error;await this.saveServers(this.getServers().filter(server=>!server.featurePackage)).catch(()=>{});}
    return this;
  }
  run(operation){const work=this.queue.then(operation);this.queue=work.catch(()=>{});return work;}
  writable(){if(this.loadError)throw Error('The feature registry could not be read. Its original contents were kept; repair it before changing features.');}
  persist(){const saving=this.persistence.then(async()=>{this.writable();await atomic(path.join(this.root,'registry.json'),{...this.unreadRecords,...this.records});this.changed();});this.persistence=saving.catch(()=>{});return saving;}
  async snapshot(directory,{managed=false}={}){
    const root=await realpath(directory);if(!managed)await this.exclude(root);else if(!inside(await realpath(this.root),root))throw Error('Invalid installed feature path.');if(!(await lstat(root)).isDirectory())throw Error('Choose a feature directory.');
    const files=[];let bytes=0,directories=0;
    const walk=async(folder,depth=0)=>{
      if(++directories>100||depth>12)throw Error('Feature directory nesting exceeds its limit.');
      for(const entry of await readdir(folder,{withFileTypes:true})){
        if(!cleanLabel(entry.name))throw Error('Package file names cannot contain control characters.');
        const file=path.join(folder,entry.name),info=await lstat(file);if(!managed)await this.exclude(file);
        if(info.isSymbolicLink()||!inside(root,await realpath(file)))throw Error('Feature packages cannot contain links or paths outside their directory.');
        if(info.isDirectory()){
          if(entry.name==='node_modules'||entry.name.startsWith('.'))throw Error('Use a self-contained package without dependency or hidden directories.');
          await walk(file,depth+1);
        }else if(info.isFile()){
          if(files.length>=100||info.size>8*1024*1024||(bytes+=info.size)>32*1024*1024)throw Error('Feature packages allow 100 files and 32 MiB total, 8 MiB per file.');
          if(info.nlink>1)throw Error('Feature packages cannot contain hard-linked files.');
          const data=await readFile(file);if(data.length!==info.size)throw Error('A package file changed during preview.');
          files.push({name:path.relative(root,file).split(path.sep).join('/'),data,sha256:hash(data)});
        }else throw Error('Only regular files are allowed.');
      }
    };
    await walk(root);return describeFiles(files,root);
  }
  cleanPreviews(){for(const [id,item]of this.previews)if(item.expires<=Date.now())this.previews.delete(id);}
  describePreview(candidate){return {previewId:candidate.previewId,manifest:candidate.manifest,sha256:candidate.digest,bytes:candidate.bytes,files:candidate.files.map(({name,sha256})=>({name,sha256})),expiresAt:candidate.expires,currentVersion:this.records[candidate.manifest.id]?.manifest.version||null,stale:(this.records[candidate.manifest.id]?.generation||null)!==candidate.baseGeneration,warning:candidate.manifest.worker?'Trusted worker: full account permissions. This is not an OS sandbox.':'Static panel: scripts, forms and network resources are blocked.'};}
  rememberPreview(snapshot,owner,inline=false){
    this.check('prepare',owner);this.cleanPreviews();
    for(const [id,item]of this.previews)if(item.owner===owner&&item.manifest.id===snapshot.manifest.id)this.previews.delete(id);
    if(this.previews.size>=20)this.previews.delete(this.previews.keys().next().value);
    const previewId=randomUUID(),candidate={...snapshot,previewId,owner,inline,expires:Date.now()+10*60_000,baseGeneration:this.records[snapshot.manifest.id]?.generation||null};
    this.previews.set(previewId,candidate);this.changed({type:'feature.preview',conversationId:owner,previewId});
    return {...this.describePreview(candidate),status:'ready',notice:'Preview only. Review it in Features in this chat, then choose Enable. No worker has been started.'};
  }
  async preview(directory,owner){return this.rememberPreview(await this.snapshot(directory),owner);}
  prepare(input,owner){
    return this.rememberPreview(describeFiles(preparedFiles(input),'Prepared in chat'),owner,true);
  }
  candidate(previewId,owner){const value=this.previews.get(previewId);if(!value||value.expires<=Date.now()||value.owner!==owner)throw Error('This preview expired or belongs to another chat. Preview the package again.');return value;}
  previewsFor(owner,{content=true}={}){this.cleanPreviews();return [...this.previews.values()].filter(item=>item.owner===owner).map(item=>{
    const textFiles=content&&item.bytes<=512*1024?item.files.filter(file=>file.data.equals(Buffer.from(file.data.toString('utf8'),'utf8'))).map(file=>({name:file.name,text:file.data.toString('utf8')})):[];
    return {...this.describePreview(item),sourceFiles:textFiles,sourceNotice:content&&textFiles.length!==item.files.length?'Some files cannot be shown as text here. Inspect the original package before enabling it.':null,panel:content&&item.manifest.panel?featurePanelSource(item.files.find(file=>file.name===item.manifest.panel).data.toString('utf8')):null};
  });}
  discard(previewId,owner){this.candidate(previewId,owner);this.previews.delete(previewId);this.changed();return {discarded:true};}
  async source({id,previewId},owner){
    const snapshot=previewId?this.candidate(previewId,owner):this.records[id]?await this.snapshot(this.directory(id,this.records[id].generation),{managed:true}):null;
    if(!snapshot)throw Error('Choose an installed feature or a preview from this chat.');
    if(!previewId&&snapshot.digest!==this.records[id]?.digest)throw Error('Package contents changed.');
    if(snapshot.bytes>512*1024||snapshot.files.some(file=>!file.data.equals(Buffer.from(file.data.toString('utf8'),'utf8'))))throw Error('This source exceeds the 512 KiB text limit or contains binary files. Use the original project files for revisions.');
    const files=snapshot.files.map(file=>({name:file.name,text:file.data.toString('utf8')}));try{preparedFiles(files);}catch(error){throw Error('This package needs its original project files for revisions: '+error.message);}
    this.check('source',owner);return {manifest:snapshot.manifest,sha256:snapshot.digest,files,notice:'Package source only; saved feature data is excluded.'};
  }
  directory(id,generation){if(!idPattern.test(id)||!/^[-a-f0-9]{36}$/.test(generation))throw Error('Invalid feature generation.');return path.join(this.root,id,'generations',generation);}
  async prune(record){const parent=path.dirname(this.directory(record.manifest.id,record.generation)),keep=new Set([record.generation,record.previous?.generation]);for(const name of await readdir(parent)){if(keep.has(name)||!/^[-a-f0-9]{36}$/.test(name))continue;const target=this.directory(record.manifest.id,name),actual=await realpath(target);if(actual!==target||(await lstat(target)).isSymbolicLink()||!inside(await realpath(this.root),actual))throw Error('Feature cleanup refused a changed path.');await rm(actual,{recursive:true});}}
  config(record){return {id:'pkg_'+record.manifest.id,name:record.manifest.name,command:this.command,args:[path.join(this.directory(record.manifest.id,record.generation),record.manifest.worker)],env:{ELECTRON_RUN_AS_NODE:'1',EXOMINA_FEATURE_DATA:path.join(this.root,record.manifest.id,'data'),EXOMINA_FEATURE_SETTINGS_FILE:path.join(this.root,record.manifest.id,'data','settings.json')},featurePackage:record.manifest.id,featureGeneration:record.generation,enabled:record.enabled};}
  async verify(config){const record=this.records[config.featurePackage];if(!record||!record.enabled||!record.manifest.worker||JSON.stringify(config)!==JSON.stringify(this.config(record)))throw Error('This feature generation was disabled or replaced.');const snapshot=await this.snapshot(this.directory(record.manifest.id,record.generation),{managed:true});if(snapshot.digest!==record.digest)throw Error('Installed feature contents changed. Preview and activate a reviewed copy.');return true;}
  async sync(record,conversationId){const id='pkg_'+record.manifest.id;const servers=this.getServers().filter(server=>server.id!==id);if(record.manifest.worker)servers.push(this.config(record));await this.saveServers(servers);await this.external.disconnect(id);if(record.enabled&&record.manifest.worker){await this.external.refresh(conversationId,{serverIds:[id],requestApproval:false});if(!this.external.status.some(item=>item.id===id&&item.connected))throw Error(this.external.status.find(item=>item.id===id)?.error||'The feature worker did not connect.');}}
  async activate(previewId,conversationId){return this.run(async()=>{
    this.writable();
    const candidate=this.candidate(previewId,conversationId),revision=this.revisions.get(candidate.manifest.id)||0;
    const current=()=>{this.check('activate',conversationId);if((this.revisions.get(candidate.manifest.id)||0)!==revision)throw Error('This feature was turned off or removed during review. Prepare a new preview.');if((this.records[candidate.manifest.id]?.generation||null)!==candidate.baseGeneration)throw Error('The feature changed since this preview. Prepare a new version before enabling it.');this.candidate(previewId,conversationId);};
    current();if(!this.idle(conversationId))throw Error('Wait for current replies to finish before changing feature workers.');
    const old=this.records[candidate.manifest.id];if(!old&&this.getServers().some(server=>server.id==='pkg_'+candidate.manifest.id))throw Error('An existing connection already uses this feature ID.');if(Object.keys(this.records).length>=20&&!old)throw Error('At most 20 feature packages can be installed.');
    if(old&&old.manifest.dataVersion!==candidate.manifest.dataVersion)throw Error('This package changes the stored data format. A reviewed migration is required.');
    const format=await json(path.join(this.root,candidate.manifest.id,'data-version.json'),null);if(format&&format.dataVersion!==candidate.manifest.dataVersion)throw Error('Retained feature data requires a reviewed migration before changing dataVersion.');
    const approved=await this.approve({title:'Activate feature “'+candidate.manifest.name+'”?',conversationId,requireConfirmation:true,action:{kind:'execute',tool:'feature_package',target:candidate.root},detail:`${candidate.manifest.description}\nVersion ${candidate.manifest.version} · API 1\nSource: ${candidate.root}\nSHA-256: ${candidate.digest}\n${candidate.manifest.worker?'Trusted Node worker with full account permissions. Only approve reviewed code.':'Static panel; no scripts or network access.'}\nFiles:\n${candidate.files.map(file=>file.name+' '+file.sha256).join('\n')}\nPersistent feature data is kept separately. Existing chats stay open.`});
    if(!approved)throw Error('Feature activation declined.');current();if(!this.idle(conversationId))throw Error('A reply started during review. Activate the feature after it finishes.');
    const fresh=candidate.inline?candidate:await this.snapshot(candidate.root);if(fresh.digest!==candidate.digest)throw Error('The source changed during review. Preview it again.');
    await assertDiskSpace(this.root,fresh.bytes,{label:'Installing this feature',reserve:WRITE_RESERVE_BYTES});current();
    const generation=randomUUID(),directory=this.directory(candidate.manifest.id,generation);
    await mkdir(directory,{recursive:true});for(const file of fresh.files){const destination=path.join(directory,file.name);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,file.data,{flag:'wx',mode:0o600});}
    await mkdir(path.join(this.root,candidate.manifest.id,'data'),{recursive:true});
    await atomic(path.join(this.root,candidate.manifest.id,'data-version.json'),{dataVersion:candidate.manifest.dataVersion});
    current();const record={manifest:candidate.manifest,generation,digest:candidate.digest,enabled:true,previous:old?{manifest:old.manifest,generation:old.generation,digest:old.digest}:null};
    this.records[record.manifest.id]=record;
    try{await this.sync(record,conversationId);this.check('activate',conversationId);if((this.revisions.get(record.manifest.id)||0)!==revision)throw Error('The feature was turned off during activation.');await this.persist();this.previews.delete(previewId);this.changed();let cleanupWarning;try{await this.prune(record);}catch(error){cleanupWarning=error.message;}return {activated:true,id:record.manifest.id,version:record.manifest.version,generation,...(cleanupWarning?{cleanupWarning}:{})};}
    catch(error){let restoreError=null;try{if(old){const restored={...old,enabled:old.enabled&&(this.revisions.get(old.manifest.id)||0)===revision};this.records[old.manifest.id]=restored;await this.sync(restored,conversationId);}else{delete this.records[record.manifest.id];await this.external.disconnect('pkg_'+record.manifest.id);await this.saveServers(this.getServers().filter(server=>server.id!=='pkg_'+record.manifest.id));}await this.persist();}catch(problem){restoreError=problem.message;}this.changed();throw Error('Feature activation failed. '+(restoreError?'Previous feature restart is unverified: '+restoreError:old?'The previous generation was restored.':'No feature was activated.')+' '+error.message);}
  });}
  change(id,action,conversationId){
    // Revocation cannot sit behind an activation approval or an in-flight call.
    // Invalidate first and stop the worker before entering the lifecycle queue.
    this.writable();let stopping=Promise.resolve();
    if(['disable','remove'].includes(action)&&this.records[id]){
      this.check(action,conversationId);this.revisions.set(id,(this.revisions.get(id)||0)+1);const disabled=this.records[id]={...this.records[id],enabled:false};
      const servers=this.getServers().filter(server=>server.id!=='pkg_'+id);if(disabled.manifest.worker)servers.push(this.config(disabled));
      stopping=Promise.allSettled([this.external.disconnect('pkg_'+id),this.saveServers(servers),this.persist()]).then(results=>{const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;});
      // The lifecycle queue may be waiting for a different approval. Capture
      // stop failures now and rethrow when that queue reaches this operation.
      stopping.catch(()=>{});this.changed();
    }
    return this.run(async()=>{
    await stopping;this.check(action,conversationId);const revision=this.revisions.get(id)||0;
    const current=()=>{this.check(action,conversationId);if((this.revisions.get(id)||0)!==revision)throw Error('This feature was turned off or removed while the change was pending.');};
    const record=this.records[id];if(!record||!['enable','disable','remove','rollback'].includes(action))throw Error('Choose an installed feature and action.');
    if(!['disable','remove'].includes(action)&&!this.idle(conversationId))throw Error('Wait for replies to finish before changing feature workers.');
    let next={...record,enabled:action==='enable'};
    if(action==='rollback'){
      if(!record.previous)throw Error('No previous generation is available.');
      if(!await this.approve({title:'Restore previous feature version?',detail:`${record.manifest.name}: ${record.manifest.version} → ${record.previous.manifest.version}\nSHA-256: ${record.previous.digest}\nSaved feature data is retained.`,conversationId,requireConfirmation:true,action:{kind:'execute',tool:'feature_package',target:id}}))throw Error('Rollback declined.');
      current();if(!this.idle(conversationId))throw Error('Wait for replies to finish.');
      next={...record.previous,enabled:true,previous:{manifest:record.manifest,generation:record.generation,digest:record.digest}};
    }
    if(next.enabled){const snapshot=await this.snapshot(this.directory(id,next.generation),{managed:true});if(snapshot.digest!==next.digest)throw Error('The installed package was modified. Preview a reviewed copy.');}
    current();this.records[id]=next;
    if(!next.enabled)await this.external.disconnect('pkg_'+id);
    try{await this.sync(next,conversationId);current();if(action==='remove'){await this.saveServers(this.getServers().filter(server=>server.id!=='pkg_'+id));delete this.records[id];}await this.persist();}
    catch(error){let restoreError=null;if(next.enabled){const restored={...record,enabled:record.enabled&&(this.revisions.get(id)||0)===revision};this.records[id]=restored;try{await this.sync(restored,conversationId);await this.persist();}catch(problem){restoreError=problem.message;}}else await this.persist().catch(()=>{});this.changed();throw Error(error.message+(restoreError?' Previous feature restart is unverified: '+restoreError:''));}
    return this.view();
  });}
  async view({content=true}={}){return Promise.all(Object.values(this.records).map(async record=>{
    let panel=null,error=null,values={};
    if(content&&record.enabled&&record.manifest.panel)try{const snapshot=await this.snapshot(this.directory(record.manifest.id,record.generation),{managed:true});if(snapshot.digest!==record.digest)throw Error('Package contents changed.');panel=snapshot.files.find(file=>file.name===record.manifest.panel).data.toString('utf8');}catch(problem){error=problem.message;}
    if(content)try{const saved=await json(path.join(this.root,record.manifest.id,'data','settings.json'),{});values=Object.fromEntries(record.manifest.settings.filter(field=>typeof saved?.[field.key]===field.type).map(field=>[field.key,saved[field.key]]));}catch(problem){error='Saved feature settings could not be read: '+problem.message;}
    return {id:record.manifest.id,name:record.manifest.name,description:record.manifest.description,version:record.manifest.version,generation:record.generation,enabled:record.enabled,trustedWorker:!!record.manifest.worker,canRollback:!!record.previous,previousVersion:record.previous?.manifest.version||null,settings:record.manifest.settings,values,panel,error};
  }));}
  async settings(id,values){return this.run(async()=>{const record=this.records[id];if(!record||!values||typeof values!=='object'||Array.isArray(values)||JSON.stringify(values).length>16000)throw Error('Invalid feature settings.');for(const[key,value]of Object.entries(values)){const field=record.manifest.settings.find(item=>item.key===key);if(!field||typeof value!==field.type||typeof value==='number'&&!Number.isFinite(value))throw Error('Setting does not match this feature’s schema.');}let saved={};try{saved=await json(path.join(this.root,id,'data','settings.json'),{});}catch{/* A valid save can repair corrupt settings. */}await atomic(path.join(this.root,id,'data','settings.json'),{...saved,...values});return this.view();});}
  async call(args,conversationId){
    const {action}=args;if(!FEATURE_PACKAGE_TOOL.inputSchema.properties.action.enum.includes(action))throw Error('Unknown feature package action.');
    this.check(action,conversationId);
    if(!['prepare','discard','activate','rollback'].includes(action)&&!await this.approve({title:'Use a feature package?',conversationId,requireConfirmation:action==='enable',action:{kind:['list','preview','source'].includes(action)?'read':'execute',tool:'feature_package',target:String(args.path||args.id||args.previewId||'installed packages')},detail:JSON.stringify(args)}))throw Error('Feature package access declined.');
    this.check(action,conversationId);
    let value=action==='list'?await this.view({content:false}):action==='prepare'?this.prepare(args.files,conversationId):action==='source'?await this.source(args,conversationId):action==='discard'?this.discard(args.previewId,conversationId):action==='preview'?await this.preview(args.path,conversationId):action==='activate'?await this.activate(args.previewId,conversationId):await this.change(args.id,action,conversationId);
    if(Array.isArray(value))value=value.map(({panel,values,...metadata})=>metadata);return {content:[{type:'text',text:JSON.stringify(value)}]};
  }
}
