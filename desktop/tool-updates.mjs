import {readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {StdioMcpClient} from './external-mcp.mjs';
import {driverConfig,approvedDriverLaunch,driverLaunchSignature} from './computer-connection.mjs';
import {inspectSignature,inspectDriverPackage,CUA_SIGNING_AUTHORITY_KEY,assertPublisher} from './tool-update-trust.mjs';
import {ConnectionRuntimeUpdates} from './connection-runtime-updates.mjs';
import {assertDiskSpace} from './disk-guard.mjs';

const REPOSITORY='trycua/cua',DAY=86400000;
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const driverState=settings=>JSON.stringify({config:driverConfig(settings),approval:settings.cuaDriverApproval,path:settings.cuaDriverPath,bundled:settings.cuaDriverBundled,managed:settings.managedCua,automatic:settings.toolUpdates?.automatic});
const PACKAGES=[['codex','ChatGPT connection','@openai/codex'],['claude','Claude connection','@anthropic-ai/claude-code-win32-x64'],['grok','Grok connection','@xai-official/grok-win32-x64'],['muse','Muse connection','@muse-code/sdk']];
export const stableVersion=value=>typeof value==='string'&&/^\d+\.\d+\.\d+$/.test(value)?value:null;
export function newerVersion(candidate,current){
  if(!stableVersion(candidate)||!stableVersion(current))return false;
  const a=candidate.split('.').map(Number),b=current.split('.').map(Number);
  for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;
}
export function driverRelease(releases,arch='x64'){
  if(!Array.isArray(releases))throw Error('The release server returned an invalid list.');
  // Upstream flags ordinary numeric releases as GitHub "pre-release" too.
  // Its stable channel uses numeric tags; nightly/rc tags never qualify.
  const releases_=releases.filter(item=>!item.draft&&/^cua-driver-rs-v\d+\.\d+\.\d+$/.test(item.tag_name||''));
  releases_.sort((a,b)=>newerVersion(a.tag_name.slice(15),b.tag_name.slice(15))?-1:newerVersion(b.tag_name.slice(15),a.tag_name.slice(15))?1:0);
  for(const release of releases_){
    const version=release.tag_name.replace('cua-driver-rs-v',''),file=`cua-driver-rs-${version}-windows-${arch==='arm64'?'arm64':'x86_64'}-binary.zip`;
    const asset=release.assets?.find(item=>item.name===file),sha=asset?.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
    if(!asset)continue;
    const expected=`https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${file}`;
    if(asset.browser_download_url!==expected||!sha||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>250000000)throw Error('The latest stable driver has no verifiable download. The installed version was kept.');
    return {version,url:expected,sha256:sha,bytes:asset.size,release:`https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`};
  }
  throw Error('No compatible stable driver release was found.');
}
async function boundedFetch(url,{json=true,limit=2000000,fetcher=fetch}={}){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!['api.github.com','github.com','registry.npmjs.org'].includes(parsed.hostname)||parsed.username||parsed.password)throw Error('Untrusted tool update address.');
  let response,current=parsed;const signal=AbortSignal.timeout(json?20000:120000);
  for(let redirects=0;redirects<=5;redirects++){
    if(current.protocol!=='https:'||current.username||current.password||current.port&&current.port!=='443'||!['api.github.com','github.com','registry.npmjs.org',...(!json?['release-assets.githubusercontent.com','objects.githubusercontent.com']:[])].includes(current.hostname))throw Error('Untrusted tool update redirect.');
    response=await fetcher(current.href,{headers:{Accept:json?'application/json':'application/octet-stream','User-Agent':'Exomina-tool-updates'},signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'manual'});
    if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===5)throw Error('Too many tool update redirects.');current=new URL(location,current);continue;}break;
  }
  if(!response.ok)throw Error(`The tool update server returned ${response.status}. Try again later.`);
  if(Number(response.headers.get('content-length'))>limit)throw Error('Tool update response is too large.');
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>limit)throw Error('Tool update response is too large.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);return json?JSON.parse(bytes.toString('utf8')):bytes;
}
function command(executable,args,{env={},timeout=60000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{shell:false,windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let output='',error='',done=false;
    const finish=(problem,value)=>{if(done)return;done=true;clearTimeout(timer);problem?reject(problem):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('Tool verification timed out. The installed version was kept.'));},timeout);
    child.stdout.on('data',data=>{output+=data;if(output.length>1000000){child.kill();finish(Error('Tool verification output was too large.'));}});child.stderr.on('data',data=>{error=(error+data).slice(-2000);});
    child.on('error',error=>finish(error));child.on('close',code=>finish(code===0?null:Error('Tool verification failed. '+error),output.trim()));
  });
}
const powershell=()=>path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');

/** Independent official packages are verified and probed before activation.
 * Bundled runtimes remain a fallback and are never overwritten.
 * Custom programs are never guessed, git-pulled or run through install scripts. */
export class ToolUpdates{
  constructor({root,runtimeRoot,packagePath=path.join(runtimeRoot,'package.json'),getSettings,saveSettings,external,providers,idle,changed=()=>{},fetcher=fetch,platform=process.platform,arch=process.arch,verifySignature=inspectSignature,run=command,probe,connectionProbe,connectionSigningKey}={}){
    Object.assign(this,{root,runtimeRoot,packagePath,getSettings,saveSettings,external,providers,idle,changed,fetcher,platform,arch,verifySignature,run,connectionProbe,connectionSigningKey});
    this.probe=probe|| (async config=>{const client=new StdioMcpClient(config);try{const info=await client.connect(),tools=await client.listTools();if(!tools.length)throw Error('The new driver exposes no tools.');return {version:info.serverInfo?.version,toolCount:tools.length};}finally{await client.close();}});
    this.state={checkedAt:null,tools:[],error:''};this.busy=false;this.activating=false;this.closed=false;this.timer=null;this.candidate=null;
  }
  async init(){
    await mkdir(this.root,{recursive:true});
    this.package=JSON.parse(await readFile(this.packagePath,'utf8'));
    if(this.providers)this.connections=new ConnectionRuntimeUpdates({root:this.root,packageInfo:this.package,getSettings:this.getSettings,saveSettings:this.saveSettings,providers:this.providers,idle:()=>!this.closed&&this.idle(),fetcher:this.fetcher,platform:this.platform,arch:this.arch,probe:this.connectionProbe,signingKey:this.connectionSigningKey,changing:value=>{this.activating=value;this.changed();}});
    try{this.provenance=JSON.parse(await readFile(path.join(this.runtimeRoot,'vendor/cua-driver/provenance.json'),'utf8'));}catch{this.provenance={};}
    try{const cached=JSON.parse(await readFile(path.join(this.root,'status.json'),'utf8'));if(Array.isArray(cached.tools))this.state={...this.state,...cached};}catch{}
    // Cache is display data only. Release candidates are always fetched afresh.
    this.schedule(15000);return this;
  }
  eligible(settings){const config=driverConfig(settings),managed=settings.managedCua;return !!config?.enabled&&approvedDriverLaunch(settings,config)&&(samePath(config.command,path.join(this.runtimeRoot,'vendor/cua-driver/cua-driver.exe'))&&settings.cuaDriverBundled!==false||!!managed&&samePath(config.command,managed.command));}
  assertCurrent(original){if(this.closed||!this.idle()||!this.eligible(this.getSettings())||driverState(this.getSettings())!==driverState(original))throw Object.assign(Error('Work, approval or tool settings changed during staging. The installed driver was kept.'),{deferred:true});}
  async saveDriver(config,fields){const current=this.getSettings();if(!current.externalMcpServers?.some(server=>server.id==='cua'))throw Error('The computer connection was removed. It was not restored.');await this.saveSettings({...fields,externalMcpServers:current.externalMcpServers.map(server=>server.id==='cua'?config:server)});}
  async removeStaged(directory){
    if(!directory)return;const resolved=path.resolve(directory),relative=path.relative(path.resolve(this.root),resolved);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!/^cua-\d+\.\d+\.\d+-[a-f0-9-]+$/i.test(relative))return;
    const active=this.getSettings().managedCua;
    if([active?.command,active?.previous?.config?.command].some(file=>typeof file==='string'&&path.resolve(file).toLowerCase().startsWith(resolved.toLowerCase()+path.sep)))return;
    await rm(resolved,{recursive:true,force:true});
  }
  async prune(){for(const entry of await readdir(this.root,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())await this.removeStaged(path.join(this.root,entry.name));}
  view(){return {...structuredClone(this.state),busy:this.busy,activating:this.activating,automatic:this.getSettings().toolUpdates?.automatic===true,automaticConnections:this.getSettings().toolUpdates?.automaticConnections===true,checkAutomatically:this.getSettings().toolUpdates?.checkAutomatically!==false};}
  async runtimeExecutable(id){return this.connections&&['codex','claude'].includes(id)?this.connections.executable(id):null;}
  schedule(delay=60000){if(this.closed)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.tick().finally(()=>this.schedule()).catch(()=>{}),delay);this.timer.unref?.();}
  async tick(){
    if(this.closed||this.busy)return;
    const settings=this.getSettings().toolUpdates||{};
    if(settings.checkAutomatically!==false&&(!this.state.checkedAt||Date.now()-Date.parse(this.state.checkedAt)>=DAY))await this.check();
    const driver=this.state.tools.find(tool=>tool.id==='cua');
    if(this.getSettings().toolUpdates?.automatic===true&&this.idle()&&driver?.available&&driver.live&&this.state.failedVersion!==driver.latest)await this.install();
    if(this.connections&&this.getSettings().toolUpdates?.automaticConnections===true&&this.idle())for(const tool of this.state.tools.filter(tool=>['codex','claude'].includes(tool.id)&&tool.available&&tool.live)){
      if(this.getSettings().toolUpdates?.automaticConnections!==true||!this.idle()||this.closed)break;
      if(this.state.failedVersions?.[tool.id]!==tool.latest)await this.install(tool.id).catch(()=>{});
    }
  }
  async record(){await writeFile(path.join(this.root,'status.json'),JSON.stringify(this.state,null,2),'utf8');this.changed();}
  async check(){
    if(this.busy)throw Error('A tool update is already in progress.');this.busy=true;this.state.error='';this.changed();
    try{
      const tools=[],settings=this.getSettings(),installed=settings.managedCua?.version||this.provenance.version||'Unknown';
      try{
        const releases=[];
        for(let page=1;page<=5;page++){const batch=await boundedFetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`,{limit:10000000,fetcher:this.fetcher});if(!Array.isArray(batch))throw Error('Invalid release list.');releases.push(...batch);if(batch.some(release=>!release.draft&&/^cua-driver-rs-v\d+\.\d+\.\d+$/.test(release.tag_name||''))||batch.length<100)break;}
        const candidate=driverRelease(releases,this.arch);this.candidate=candidate;
        const custom=!this.eligible(settings),supported=this.platform==='win32'&&['x64','arm64'].includes(this.arch);
        tools.push({id:'cua',name:'Computer control',installed,latest:candidate.version,available:newerVersion(candidate.version,installed),live:supported&&!custom,source:candidate.release,reason:custom?'Set up the bundled computer driver, or manage your custom driver yourself.':!supported?'Use the platform’s driver installer. Live signed-driver updates currently support Windows x64 and ARM64.':!stableVersion(installed)?'The installed driver version could not be determined.':'Only the driver reconnects. Exomina stays open.'});
      }catch(error){tools.push({id:'cua',name:'Computer control',installed,error:error.message,live:false});}
      for(const [id,name,pkg]of PACKAGES){
        if(this.connections&&['codex','claude'].includes(id)){if(this.connections.enabled(id))try{tools.push(await this.connections.check(id));}catch(error){tools.push({id,name,installed:this.connections.installed(id),live:false,error:error.message});}continue;}
        const installed=this.package.dependencies?.[pkg];if(!installed)continue;
        try{const metadata=await boundedFetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,{fetcher:this.fetcher});const latest=stableVersion(metadata.version);if(!latest)throw Error('No stable package version was reported.');tools.push({id,name,installed,latest,available:newerVersion(latest,installed),live:false,updateMethod:'app-release',source:`https://www.npmjs.com/package/${pkg}`,reason:newerVersion(latest,installed)?'A newer version is published upstream. This connection updates with an Exomina release after compatibility checks; it cannot be installed separately here.':'This version is bundled with your installed Exomina release.'});}
        catch(error){tools.push({id,name,installed,live:false,error:error.message});}
      }
      this.state={...this.state,checkedAt:new Date().toISOString(),tools,error:''};await this.record();return this.view();
    }catch(error){this.state.error=error.message;await this.record();throw error;}
    finally{this.busy=false;this.changed();}
  }
  async connectionAction(id,rollback=false){
    if(!this.connections||!['codex','claude'].includes(id))throw Error('Choose an available connection runtime.');
    if(this.busy)throw Error('A tool update is already in progress.');
    if(!this.idle())throw Error('Connection updates wait until replies, commands and voice are idle. Exomina does not need to restart.');
    this.busy=true;this.state.error='';this.changed();
    try{
      const result=await this.connections[rollback?'rollback':'install'](id),item=this.state.tools.find(tool=>tool.id===id);
      if(item){item.installed=result.version;item.available=newerVersion(item.latest,item.installed);item.canRollback=!!this.getSettings().managedRuntimes?.[id]?.previous;item.reason=rollback?'Previous connection restored. New requests use it without restarting Exomina.':'Updated and checked. New requests use this connection without restarting Exomina.';}
      this.state.failedVersions||={};if(rollback)this.state.failedVersions[id]=result.failedVersion;else delete this.state.failedVersions[id];
      await this.record();return this.view();
    }catch(error){this.state.error=error.message;if(!error.deferred){const item=this.state.tools.find(tool=>tool.id===id);this.state.failedVersions={...this.state.failedVersions,[id]:item?.latest};}await this.record();throw error;}
    finally{this.busy=false;this.activating=false;this.changed();}
  }
  async install(id='cua'){
    if(id!=='cua')return this.connectionAction(id);
    if(this.busy)throw Error('A tool update is already in progress.');
    if(!this.idle())throw Error('Tool updates wait until replies, commands and voice are idle. Exomina does not need to restart.');
    if(!this.candidate){await this.check();return this.install();}
    const item=this.state.tools.find(tool=>tool.id==='cua'),candidate=this.candidate;
    if(!item?.available||!item.live||!candidate||!this.eligible(this.getSettings()))throw Error(item?.error||item?.reason||'No compatible live update is available.');
    const original=structuredClone(this.getSettings()),old=driverConfig(original);
    if(!old?.enabled||!approvedDriverLaunch(original,old))throw Error('Set up computer control before updating its driver.');
    this.busy=true;this.state.error='';this.changed();let directory;
    try{
      await assertDiskSpace(this.root,candidate.bytes*3,{label:'Updating this tool'});
      const bytes=await boundedFetch(candidate.url,{json:false,limit:candidate.bytes,fetcher:this.fetcher});
      if(bytes.length!==candidate.bytes||createHash('sha256').update(bytes).digest('hex')!==candidate.sha256)throw Error('Driver checksum verification failed. The installed version was kept.');
      directory=path.join(this.root,`cua-${candidate.version}-${randomUUID()}`);await mkdir(directory);
      const archive=path.join(directory,'release.zip'),extracted=path.join(directory,'program');await mkdir(extracted);await writeFile(archive,bytes);
      await this.run(powershell(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(this.runtimeRoot,'desktop/tool-update-extract.ps1'),'-Archive',archive,'-Destination',extracted]);
      const program=await inspectDriverPackage(extracted,this.verifySignature),executable=program.executable,publisher=CUA_SIGNING_AUTHORITY_KEY;
      const candidateConfig={...old,command:executable};
      this.assertCurrent(original);
      this.activating=true;this.changed();
      // Only handshake and tool discovery; never capture or operate the desktop.
      const smoke=await this.probe(candidateConfig);
      if(smoke.version!==candidate.version)throw Error('The downloaded driver reported a different version.');
      this.assertCurrent(original);
      const managed={version:candidate.version,command:executable,sha256:candidate.sha256,publisher,files:program.files,previous:{config:old,path:original.cuaDriverPath,managed:original.managedCua?{...original.managedCua,previous:null}:null,bundled:original.cuaDriverBundled,approval:original.cuaDriverApproval},updatedAt:new Date().toISOString()};
      try{
        await this.saveDriver(candidateConfig,{cuaDriverPath:executable,cuaDriverBundled:false,cuaDriverApproval:{signature:driverLaunchSignature(candidateConfig),bundled:false},managedCua:managed});
        await this.external.disconnect('cua');await this.external.refresh(undefined,{serverIds:['cua'],requestApproval:false});
        if(!this.external.status.some(server=>server.id==='cua'&&server.connected))throw Error('The new driver could not reconnect.');
      }catch(error){
        await this.saveDriver(old,{cuaDriverPath:original.cuaDriverPath,cuaDriverBundled:original.cuaDriverBundled,cuaDriverApproval:original.cuaDriverApproval,managedCua:original.managedCua||null});
        await this.external.disconnect('cua');await this.external.refresh(undefined,{serverIds:['cua'],requestApproval:false});if(!this.external.status.some(server=>server.id==='cua'&&server.connected))throw Error(error.message+' Recovery could not reconnect the previous driver.');throw Error(error.message+' The previous driver configuration was restored.');
      }
      item.installed=candidate.version;item.available=false;delete this.state.failedVersion;item.reason='Updated and reconnected without restarting Exomina.';await this.record();await this.prune().catch(()=>{});return this.view();
    }catch(error){this.state.error=error.message;if(!error.deferred)this.state.failedVersion=candidate.version;await this.removeStaged(directory).catch(()=>{});await this.record();throw error;}
    finally{this.busy=false;this.activating=false;this.changed();}
  }
  async rollback(id='cua'){
    if(id!=='cua')return this.connectionAction(id,true);
    if(this.busy||!this.idle())throw Error('Wait until tool updates and active work finish.');
    this.busy=true;this.changed();const settings=structuredClone(this.getSettings()),current=settings.managedCua,previous=current?.previous,config=driverConfig(settings);let switched=false;
    try{
      if(!previous?.config)throw Error('No previous managed driver is available.');
      if(!this.eligible(settings))throw Error('Enable the managed computer driver before restoring its previous version.');
      if(samePath(previous.config.command,path.join(this.runtimeRoot,'vendor/cua-driver/cua-driver.exe')))assertPublisher(await this.verifySignature(previous.config.command));
      else{const restored=await inspectDriverPackage(path.dirname(previous.config.command),this.verifySignature);if(JSON.stringify(restored.files)!==JSON.stringify(previous.managed?.files))throw Error('The previous managed driver changed on disk.');}
      if(!approvedDriverLaunch({...settings,cuaDriverApproval:previous.approval},previous.config))throw Error('The previous driver approval is no longer valid.');
      this.assertCurrent(settings);this.activating=true;switched=true;
      await this.saveDriver(previous.config,{cuaDriverPath:previous.path,cuaDriverBundled:previous.bundled,cuaDriverApproval:previous.approval,managedCua:previous.managed});await this.external.disconnect('cua');await this.external.refresh(undefined,{serverIds:['cua'],requestApproval:false});
      if(!this.external.status.some(server=>server.id==='cua'&&server.connected))throw Error('The previous driver did not reconnect.');
      const item=this.state.tools.find(tool=>tool.id==='cua');if(item){item.installed=previous.managed?.version||this.provenance.version;item.available=newerVersion(item.latest,item.installed);}this.state.failedVersion=current.version;await this.record();return this.view();
    }catch(error){if(switched){try{await this.saveDriver(config,{cuaDriverPath:settings.cuaDriverPath,cuaDriverBundled:settings.cuaDriverBundled,cuaDriverApproval:settings.cuaDriverApproval,managedCua:settings.managedCua});await this.external.disconnect('cua');await this.external.refresh(undefined,{serverIds:['cua'],requestApproval:false});}catch(recovery){throw Error(`${error.message} Recovery could not be verified: ${recovery.message}`);}}throw error;}
    finally{this.activating=false;this.busy=false;this.changed();}
  }
  close(){this.closed=true;clearTimeout(this.timer);}
}
