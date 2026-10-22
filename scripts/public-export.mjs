// Shared public-export policy and explicit three-way reconciliation.
import {cp,mkdir,readdir,readFile,writeFile,lstat,unlink,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import os from 'node:os';

const run=promisify(execFile);
const publicRoots=new Set(['desktop','src','test','cloud','public','scripts','build','docs','.github']);
const rootDocuments=new Set(['.gitignore','index.html','remote.html','vite.config.mjs','package.json','package-lock.json','LICENSE','NOTICE','README.md','BETA.md','BUILDING.md','BUILD-WINDOWS.md','CHAT-MEMORY.md','FEEDBACK.md','START-HERE.txt','SUPPORT.md','PROVIDER-TOOLS.md','PUBLIC-UPDATES.md','TERMINAL.md','THIRD-PARTY-NOTICES.txt','SECURITY-AUDIT.txt','VALIDATION.txt']);
const generated=new Set(['desktop/distribution.mjs','desktop/theme-catalog.mjs','src/voice-preview-clips.js','scripts/prepare-beta-release.mjs','scripts/public-export.mjs']);

export function publicPathAllowed(relative){
 const normalized=relative.replaceAll('\\','/');
 if(!normalized||normalized.startsWith('/')||normalized.split('/').some(part=>part==='..'))return false;
 if(!publicRoots.has(normalized.split('/')[0])&&!rootDocuments.has(normalized))return false;
 return !/(^|\/)(?:data|Private|accounts|\.git|\.verification|node_modules|dist|release(?:-[^/]+)?|output|__pycache__)(\/|$)/i.test(normalized)&&
  !/(?:^|\/)theme-art(?:\/|$)/.test(normalized)&&!/^src\/assets\/(?:voice-previews|voice-previews-clear|claude-voice-previews)(?:\/|$)/.test(normalized)&&
  !/(?:theme-catalog-full\.mjs|voice-preview-clips-personal\.js)$/.test(normalized)&&! /\.(?:log|sqlite(?:3)?|db|pfx|p12|key|pem|pyc|pyo)$/i.test(normalized)&&
  !(path.posix.basename(normalized).startsWith('.env')&&!normalized.endsWith('.example'));
}

export async function applyPublicTemplate(sourceRoot,output){
 const template=path.join(sourceRoot,'scripts','public-template');
 await cp(template,output,{recursive:true,filter:entry=>path.basename(entry)!=='package-overlay.json'});
 const text=await readFile(path.join(template,'package-overlay.json'),'utf8');
 return JSON.parse(text.replace(/^\uFEFF/,''));
}

// Preserve unrelated changes in the public branch and local release. Conflicts
// stay explicit; neither branch silently wins when both changed the same value.
const absent=Symbol('absent');
export function mergePublicJson(ancestor,ours,theirs,location='package'){
 if(isDeepStrictEqual(ours,theirs)||isDeepStrictEqual(theirs,ancestor))return ours;
 if(isDeepStrictEqual(ours,ancestor))return theirs;
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&value!==absent;
 if(object(ours)&&object(theirs)&&(object(ancestor)||ancestor===absent)){
  const result={};
  for(const key of new Set([...Object.keys(ancestor===absent?{}:ancestor),...Object.keys(ours),...Object.keys(theirs)])){
   const value=mergePublicJson(ancestor!==absent&&Object.hasOwn(ancestor,key)?ancestor[key]:absent,Object.hasOwn(ours,key)?ours[key]:absent,Object.hasOwn(theirs,key)?theirs[key]:absent,`${location}.${key}`);
   if(value!==absent)result[key]=value;
  }
  return result;
 }
 if([ancestor,ours,theirs].every(value=>Array.isArray(value)&&value.every(item=>typeof item==='string'))){
  const removed=new Set(ancestor.filter(item=>!ours.includes(item)||!theirs.includes(item)));
  return [...new Set([...ours,...theirs])].filter(item=>!removed.has(item));
 }
 throw Error(`Public reconciliation conflict: ${location}`);
}

async function filesAt(root){
 const files=new Map();
 async function walk(directory,relative=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const name=relative?`${relative}/${entry.name}`:entry.name;
   if(!publicPathAllowed(name))continue;
   if(entry.isSymbolicLink())throw Error(`Public source links are not allowed: ${name}`);
   if(entry.isDirectory())await walk(path.join(directory,entry.name),name);
   else if(entry.isFile())files.set(name,await readFile(path.join(directory,entry.name)));
  }
 }
 await walk(root);return files;
}
const same=(a,b)=>a===undefined?b===undefined:b!==undefined&&a.equals(b);
const decode=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);

export async function reconcilePublicBase(output,publicBase,ancestor){
 if(!publicBase||!ancestor)throw Error('Public reconciliation needs both --public-base and --public-base-ancestor.');
 const outputPath=path.resolve(output);
 for(const directory of [publicBase,ancestor]){
  const relative=path.relative(outputPath,path.resolve(directory));
  if(!relative||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Public base folders must be outside the export folder.');
  if(!(await lstat(directory)).isDirectory())throw Error('Public base and ancestor must be directories.');
 }
 const [baseFiles,ancestorFiles,ourFiles]=await Promise.all([filesAt(publicBase),filesAt(ancestor),filesAt(output)]);
 const changed=[],conflicts=[],pending=[];
 const scratch=await mkdtemp(path.join(os.tmpdir(),'exomina-public-merge-'));
 try{
  for(const relative of new Set([...ancestorFiles.keys(),...baseFiles.keys()])){
   if(generated.has(relative)||relative.startsWith('scripts/public-template/')||relative.startsWith('scripts/beta-docs/'))continue;
   const base=ancestorFiles.get(relative),ours=ourFiles.get(relative),theirs=baseFiles.get(relative);
   if(same(base,theirs)||same(ours,theirs))continue;
   let merged;
   if(same(ours,base))merged=theirs;
   else if(base===undefined||ours===undefined||theirs===undefined){conflicts.push(relative);continue;}
   else if(relative==='package.json'||relative==='package-lock.json'){
    try{merged=Buffer.from(JSON.stringify(mergePublicJson(JSON.parse(decode(base)),JSON.parse(decode(ours)),JSON.parse(decode(theirs)),relative),null,2)+'\n');}
    catch(error){conflicts.push(`${relative}: ${error.message}`);continue;}
   }else{
    try{
     for(const [file,bytes] of [['ours',ours],['ancestor',base],['theirs',theirs]])await writeFile(path.join(scratch,file),decode(bytes),'utf8');
     const result=await run('git',['merge-file','--diff3','-p',path.join(scratch,'ours'),path.join(scratch,'ancestor'),path.join(scratch,'theirs')],{encoding:'utf8',maxBuffer:32*1024*1024});
     merged=Buffer.from(result.stdout);
    }catch{conflicts.push(relative);continue;}
   }
   pending.push({relative,merged});
  }
  if(conflicts.length)throw Error(`Public reconciliation requires review (${conflicts.length}):\n${conflicts.join('\n')}`);
  for(const {relative,merged} of pending){
   const target=path.join(output,relative);
   if(merged===undefined){if(ourFiles.has(relative))await unlink(target);}
   else {await mkdir(path.dirname(target),{recursive:true});await writeFile(target,merged);}
   changed.push(relative);
  }
 }finally{await rm(scratch,{recursive:true,force:true});}
 return {changed,conflicts:[]};
}
