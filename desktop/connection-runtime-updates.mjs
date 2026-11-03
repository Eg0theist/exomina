import {mkdir,readFile,readdir,rm,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {runtimeTarget,registryFetch,verifiedManifest,downloadRuntimePackage,extractRuntimePackage,inspectRuntimePackage,runtimeInventory,runtimeFileSnapshot,plainDirectory,connectionVersion} from './connection-runtime-packages.mjs';
import {probeConnectionRuntime} from './connection-runtime-probe.mjs';

const nameOf=id=>id==='codex'?'ChatGPT connection':'Claude connection';
export function connectionNewer(a,b){if(!connectionVersion(a)||!connectionVersion(b))return false;const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;}
const fingerprint=(settings,id)=>JSON.stringify({managed:settings.managedRuntimes?.[id]||null,automatic:settings.toolUpdates?.automaticConnections});
const deferred=()=>Object.assign(Error('Active work or connection-update settings changed. The current version was kept.'),{deferred:true});

export class ConnectionRuntimeUpdates{
  constructor({root,packageInfo,getSettings,saveSettings,providers,idle,fetcher=fetch,platform=process.platform,arch=process.arch,probe=probeConnectionRuntime,signingKey,changing=()=>{}}){Object.assign(this,{root,packageInfo,getSettings,saveSettings,providers,idle,fetcher,platform,arch,probe,signingKey,changing});this.staging=new Set();this.validation=new Map();}
  target(id){return runtimeTarget(id,this.platform,this.arch);}
  bundledVersion(id){const deps={...this.packageInfo.optionalDependencies,...this.packageInfo.dependencies};return connectionVersion(id==='codex'?deps['@openai/codex']:deps[`@anthropic-ai/claude-code-${this.platform}-${this.arch}`]||deps['@anthropic-ai/claude-code']);}
  enabled(id){try{this.target(id);}catch{return false;}return ['codex','claude'].includes(id)&&(this.bundledVersion(id)?this.providers?.isProviderEnabled(id)!==false:id==='claude'&&this.providers?.isProviderEnabled(id)===true);}
  managed(id){const record=this.getSettings().managedRuntimes?.[id];return record&&connectionNewer(record.version,this.bundledVersion(id)||'0.0.0')?record:null;}
  installed(id){return this.managed(id)?.version||this.bundledVersion(id);}
  async release(id){
    const target=this.target(id),metadata=await registryFetch(`https://registry.npmjs.org/${encodeURIComponent(target.package)}/latest`,{fetcher:this.fetcher}),version=connectionVersion(metadata.version);
    if(!version||metadata.deprecated)throw Error('The official registry did not report a supported stable connection release.');
    verifiedManifest(metadata,target.package,version,{key:this.signingKey});
    let manifest;
    if(id==='codex'){
      const nativeVersion=`${version}-${this.platform}-${this.arch}`,alias=`@openai/codex-${this.platform}-${this.arch}`;
      if(metadata.optionalDependencies?.[alias]!==`npm:@openai/codex@${nativeVersion}`)throw Error('The release does not include the expected native connection package.');
      const native=await registryFetch(`https://registry.npmjs.org/${encodeURIComponent(target.package)}/${nativeVersion}`,{fetcher:this.fetcher});
      if(native.deprecated)throw Error('This connection release has been withdrawn by its publisher.');
      manifest=verifiedManifest(native,target.package,nativeVersion,{platform:this.platform,arch:this.arch,key:this.signingKey});
    }else manifest=verifiedManifest(metadata,target.package,version,{platform:this.platform,arch:this.arch,key:this.signingKey});
    return {target,version,manifest};
  }
  async check(id){
    const base={id,name:nameOf(id),installed:this.installed(id),source:`https://www.npmjs.com/package/${this.target(id).package}`,updateMethod:'connection-runtime',live:true,canRollback:!!this.managed(id)?.previous};
    try{const release=await this.release(id);return {...base,latest:release.version,available:!base.installed||connectionNewer(release.version,base.installed),reason:'Verified official packages are checked for compatibility. New requests use the update without restarting Exomina; the previous version is kept.'};}
    catch(error){return {...base,live:false,error:error.message};}
  }
  assertCurrent(id,original){if(!this.idle()||!this.enabled(id)||fingerprint(original,id)!==fingerprint(this.getSettings(),id)||this.providers.runtimeChangeBusy?.())throw deferred();}
  slot(record,id){
    if(!record||!connectionVersion(record.version))throw Error('Invalid managed connection record.');
    const relative=path.relative(path.resolve(this.root),path.resolve(record.directory||'.'));
    if(path.isAbsolute(relative)||relative.includes(path.sep)||!new RegExp(`^connection-${id}-${record.version.replaceAll('.','\\.')}-[a-f0-9-]{36}$`,this.platform==='win32'?'i':'').test(relative))throw Error('The managed connection is outside its versioned update folder.');
    const expected=path.join(this.root,relative,'program','package'),program=path.relative(expected,record.command||'');
    if(!program||program.startsWith('..')||path.isAbsolute(program))throw Error('The managed connection executable is outside its verified package.');
    return {directory:path.join(this.root,relative),program:expected};
  }
  async validate(record,id){
    const slot=this.slot(record,id);await plainDirectory(slot.directory);
    const key=JSON.stringify(record),snapshot=await runtimeFileSnapshot(slot.program),cached=this.validation.get(id);
    if(cached?.key===key&&cached.snapshot===snapshot)return record.command;
    const actual=await inspectRuntimePackage(slot.program,this.target(id),record.version);
    if(!this.same(actual.command,record.command)||JSON.stringify(actual.files)!==JSON.stringify(record.files))throw Error('A managed connection changed on disk. Restore its previous version before using it.');
    this.validation.set(id,{key,snapshot});return actual.command;
  }
  async executable(id){const record=this.managed(id);return record?this.validate(record,id):null;}
  same(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const normalize=value=>{const resolved=path.resolve(value);return this.platform==='win32'?resolved.toLowerCase():resolved;};return normalize(a)===normalize(b);}
  async save(id,value){
    const map={...this.getSettings().managedRuntimes};if(value)map[id]=value;else delete map[id];await this.saveSettings({managedRuntimes:map});
  }
  async switch(id,original,next){
    this.assertCurrent(id,original);this.changing(true);
    try{
      await this.providers.withRuntimeChange(id,async()=>{
        this.assertCurrent(id,original);
        try{await this.save(id,next);}catch(error){await this.save(id,original.managedRuntimes?.[id]||null);throw error;}
      });
    }finally{this.changing(false);}
  }
  async install(id){
    if(!this.enabled(id)||!this.idle())throw deferred();
    const original=structuredClone(this.getSettings());let directory;
    try{
      // Always resolve signed metadata afresh. The display cache is not authority.
      const release=await this.release(id);if(this.installed(id)&&!connectionNewer(release.version,this.installed(id)))throw Error('This connection is already up to date.');
      this.assertCurrent(id,original);await plainDirectory(this.root);directory=path.join(this.root,`connection-${id}-${release.version}-${randomUUID()}`);await mkdir(directory);this.staging.add(directory);const program=path.join(directory,'program');await mkdir(program);
      const archive=path.join(directory,'download.tgz');await downloadRuntimePackage(release.manifest,archive,{fetcher:this.fetcher});this.assertCurrent(id,original);
      const extracted=await extractRuntimePackage(archive,program,{limit:release.manifest.unpackedSize});await rm(archive);if(extracted.bytes!==release.manifest.unpackedSize)throw Error('The connection package size differs from its registry metadata.');
      const inspected=await inspectRuntimePackage(path.join(program,'package'),release.target,release.version);
      const smoke=await this.probe(id,inspected.command,release.version,directory);if(smoke?.version!==release.version)throw Error('Connection compatibility checks did not confirm its version.');
      // The executable and sidecars are checked again after the probe.
      if(JSON.stringify(await runtimeInventory(path.join(program,'package')))!==JSON.stringify(inspected.files))throw Error('The connection package changed during compatibility checks.');
      const previous=this.managed(id),fallback=previous?null:await this.providers.bundledExecutable(id),record={version:release.version,directory,command:inspected.command,files:inspected.files,integrity:release.manifest.integrity,package:release.manifest.name,updatedAt:new Date().toISOString(),previous:previous?{...previous,previous:null}:fallback?{bundled:true}:null};
      await this.switch(id,original,record);await this.prune().catch(()=>{});return {version:release.version,checks:smoke.checks};
    }catch(error){if(directory){this.staging.delete(directory);await this.remove(directory).catch(()=>{});}throw error;}
    finally{this.staging.delete(directory);}
  }
  async rollback(id){
    const original=structuredClone(this.getSettings()),current=this.managed(id),previous=current?.previous;
    if(!previous)throw Error('No previous connection version is available.');
    this.assertCurrent(id,original);
    if(!previous.bundled)await this.validate(previous,id);
    else if(!await this.providers.bundledExecutable(id))throw Error('The bundled fallback connection is missing.');
    await this.switch(id,original,previous.bundled?null:previous);await this.prune().catch(()=>{});return {version:previous.bundled?this.bundledVersion(id):previous.version,failedVersion:current.version};
  }
  async remove(directory){
    const relative=path.relative(path.resolve(this.root),path.resolve(directory));if(path.isAbsolute(relative)||relative.includes(path.sep)||!/^connection-(?:codex|claude)-\d+\.\d+\.\d+-[a-f0-9-]{36}$/.test(relative))return;
    const map=this.getSettings().managedRuntimes||{};if([...this.staging,...Object.values(map).flatMap(record=>[record?.directory,record?.previous?.directory])].some(active=>this.same(active,directory)))return;
    const entry=await lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!entry)return;if(entry.isSymbolicLink()||!entry.isDirectory())throw Error('Refusing to remove a linked connection folder.');await plainDirectory(this.root);await rm(directory,{recursive:true,force:true});
  }
  async prune(){for(const entry of await readdir(this.root,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&&entry.name.startsWith('connection-'))await this.remove(path.join(this.root,entry.name));}
}
