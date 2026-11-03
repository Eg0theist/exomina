// Check inputs independently of electron-builder's dependency collector. A linked
// node_modules previously let the collector silently omit production packages.
import {lstat,realpath,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {listPackage,extractFile,uncache} from '@electron/asar';

const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const excluded=(name,patterns)=>patterns.some(pattern=>pattern.endsWith('/*')?name.startsWith(pattern.slice(0,-1)):name===pattern);
const compatible=(values,target)=>{if(!values)return true;values=Array.isArray(values)?values:[values];return !values.includes('!'+target)&&(values.every(value=>value.startsWith('!'))||values.includes(target));};
const parse=bytes=>JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));

export async function runtimeDependencies(root,{exclude=[],platform=process.platform,arch=process.arch}={}){
 root=await realpath(root);
 const modules=path.join(root,'node_modules'),info=await lstat(modules);
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(modules)!==modules)throw Error('Packaging requires a local, regular node_modules directory. Replace the link with npm ci --ignore-scripts before packaging.');
 const packages=new Map();
 async function manifest(directory){
  // Checking every component also rejects junctions hidden below a scope.
  let current=root;
  for(const part of path.relative(root,directory).split(path.sep)){
   current=path.join(current,part);const entry=await lstat(current);
   if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('Linked dependency directories cannot be packaged: '+path.relative(root,current));
  }
  if(!inside(root,await realpath(directory)))throw Error('Dependency resolves outside the checkout.');
  return parse(await readFile(path.join(directory,'package.json')));
 }
 async function resolve(name,from){
  if(!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name))throw Error('Invalid dependency name: '+name);
  for(let current=from;inside(root,current);current=path.dirname(current)){
   if(path.basename(current)==='node_modules')continue;
   const directory=path.join(current,'node_modules',name);
   try{return {directory,metadata:await manifest(directory)};}catch(error){if(error.code!=='ENOENT')throw error;}
   if(current===root)break;
  }
 }
 async function visit(metadata,directory){
  const optional=metadata.optionalDependencies||{};
  for(const name of new Set([...Object.keys(metadata.dependencies||{}),...Object.keys(optional)])){
   if(excluded(name,exclude))continue;
   const found=await resolve(name,directory);
   if(!found){if(name in optional)continue;throw Error('Required production dependency is missing: '+name);}
   if(!compatible(found.metadata.os,platform)||!compatible(found.metadata.cpu,arch)){
    if(name in optional)continue;
    throw Error('Required production dependency does not match the package target: '+name);
   }
   const request={from:directory,name};
   if(packages.has(found.directory)){packages.get(found.directory).requests.push(request);continue;}
   packages.set(found.directory,{...found,requests:[request]});
   await visit(found.metadata,found.directory);
  }
 }
 await visit(parse(await readFile(path.join(root,'package.json'))),root);
 return [...packages.values()].map(entry=>({...entry,relative:path.relative(root,entry.directory).replaceAll(path.sep,'/')}));
}

export async function verifyPackageDependencies(root,archive,options={}){
 const packages=await runtimeDependencies(root,options);
 uncache(archive);
 const entries=new Set(listPackage(archive).map(name=>name.replaceAll('\\','/').replace(/^\//,'')));
 const locations=new Map([[await realpath(root),'']]);
 function resolvePacked(name,from){
  for(let directory=from;;directory=path.posix.dirname(directory)){
   if(path.posix.basename(directory)!=='node_modules'){
    const relative=path.posix.join(directory,'node_modules',name);
    if(entries.has(relative+'/package.json'))return relative;
   }
   if(!directory||directory==='.')break;
  }
  throw Error('Packaged production dependency file is missing: '+path.posix.join(from,'node_modules',name,'package.json'));
 }
 let entrypoints=0,nativeFiles=0;
 const required=relative=>{if(!entries.has(relative))throw Error('Packaged production dependency file is missing: '+relative);};
 async function checkFile(entry,relative,location){
  const normalized=path.posix.normalize(relative.replaceAll('\\','/').replace(/^\.\//,''));
  if(normalized.startsWith('../')||path.posix.isAbsolute(normalized))throw Error('Dependency file escapes its package: '+relative);
  const packed=location+'/'+normalized;required(packed);
  // All node_modules are unpacked by the app's configuration. Check the actual
  // bytes too; an ASAR header alone cannot prove the unpacked file was copied.
  const source=await readFile(path.join(entry.directory,normalized));
  let actual;try{actual=extractFile(archive,packed.split('/').join(path.sep));}catch{throw Error('Packaged production dependency bytes are missing: '+packed);}
  if(!source.equals(actual))throw Error('Packaged production dependency bytes differ: '+packed);
 }
 const verified=new Set();
 async function verifyEntry(entry,location){
  const key=entry.directory+'\0'+location;if(verified.has(key))return;verified.add(key);
  const manifest=location+'/package.json';required(manifest);
  const actual=parse(extractFile(archive,manifest.split('/').join(path.sep)));
  if(actual.name!==entry.metadata.name||actual.version!==entry.metadata.version)throw Error('Packaged production dependency version differs: '+entry.relative);
  const starts=new Set([...(entry.metadata.main?[entry.metadata.main]:[]),...Object.values(typeof entry.metadata.bin==='string'?{bin:entry.metadata.bin}:entry.metadata.bin||{})]);
  function exports(value){
   if(typeof value==='string'){if(value.startsWith('./')&&!value.includes('*')&&!/\.d\.[cm]?ts$/.test(value))starts.add(value);}
   else if(value&&typeof value==='object')for(const [condition,target]of Object.entries(value))if(condition!=='types')exports(target);
  }
  exports(entry.metadata.exports);
  if(!entry.metadata.main&&!entry.metadata.exports)starts.add('index.js');
  for(const start of starts){
   if(typeof start!=='string')throw Error('Invalid dependency entrypoint: '+entry.relative);
   const normalized=path.posix.normalize(start.replaceAll('\\','/'));
   if(normalized.startsWith('../')||path.posix.isAbsolute(normalized)||path.win32.isAbsolute(start))throw Error('Dependency entrypoint escapes its package: '+start);
   // Builder intentionally prunes package scripts/dev metadata. Name/version
   // were checked above; exported package.json cannot be byte-identical.
   if(normalized==='package.json')continue;
   let found;
   for(const candidate of [start,start+'.js',start+'.json',start+'.node',path.posix.join(start,'index.js')]){
    try{if((await lstat(path.join(entry.directory,candidate))).isFile()){found=candidate;break;}}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
   }
   // Some packages declare a legacy main alongside exports; only enforce files
   // actually supplied by the installed upstream distribution.
   if(found){await checkFile(entry,found,location);entrypoints++;}
  }
  async function binaries(directory,relative=''){
   for(const file of await readdir(directory,{withFileTypes:true})){
    if(file.name==='node_modules')continue;
    const name=path.posix.join(relative,file.name);
    if(file.isSymbolicLink())continue;
    if(file.isDirectory())await binaries(path.join(directory,file.name),name);
    else if(/\.(?:exe|dll|node|pyd|wasm|dylib|so(?:\.\d+)*)$/i.test(file.name)||(process.platform!=='win32'&&((await lstat(path.join(directory,file.name))).mode&0o111))){await checkFile(entry,name,location);nativeFiles++;}
   }
  }
  await binaries(entry.directory);
 }
 for(const entry of packages){
  const request=entry.requests[0],location=resolvePacked(request.name,locations.get(request.from));
  locations.set(entry.directory,location);await verifyEntry(entry,location);
 }
 // Check every requesting parent too, including shared/cyclic dependencies.
 // Builder can hoist nested packages, so use the output's Node resolution rules.
 for(const entry of packages)for(const request of entry.requests){
  const location=resolvePacked(request.name,locations.get(request.from));
  await verifyEntry(entry,location);
 }
 return {passed:true,packages:packages.length,entrypoints,nativeFiles};
}

export function packageResources(context){
 return context.electronPlatformName==='darwin'
  ?path.join(context.appOutDir,context.packager.appInfo.productFilename+'.app','Contents','Resources')
  :path.join(context.appOutDir,'resources');
}
function targetOptions(context,options){
 const arch=typeof context.arch==='number'?{0:'ia32',1:'x64',2:'arm',3:'arm64',4:'universal'}[context.arch]:context.arch;
 return {platform:context.electronPlatformName||process.platform,arch:arch||process.arch,...options};
}
export async function beforePack(context,options={}){
 await runtimeDependencies(context.packager.appDir||context.packager.projectDir,targetOptions(context,options));
}
export async function afterPack(context,options={}){
 const result=await verifyPackageDependencies(context.packager.appDir||context.packager.projectDir,path.join(packageResources(context),'app.asar'),targetOptions(context,options));
 console.log('Verified packaged production dependencies: '+JSON.stringify(result));
 return result;
}
