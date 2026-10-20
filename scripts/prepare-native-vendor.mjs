// Only pinned public program archives. Never reads any installed account profile.
import {readFile,writeFile,mkdir,mkdtemp,lstat,stat,rename,chmod,readdir,readlink,copyFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeVendorTargets,validateNativeArchiveEntries} from './native-vendor-config.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const work=path.join(root,'.runtime-work');
const vendor=path.join(root,'vendor');
const run=promisify(execFile);
const arguments_=process.argv.slice(2);
if(arguments_.some(argument=>argument!=='--python-only'))throw Error('Only --python-only is supported.');
const pythonOnly=arguments_.includes('--python-only');
const targets=nativeVendorTargets().filter(target=>!pythonOnly||target.dir==='python');
await mkdir(work,{recursive:true,mode:0o700});await mkdir(vendor,{recursive:true});

function inside(base,target) {
 const relative=path.relative(base,target);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Runtime preparation target must stay inside its program directory.');
}
async function verifyProgramTree(directory,stage) {
 await chmod(directory,0o755);
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const location=path.join(directory,entry.name);
  if(entry.isSymbolicLink()){
   const link=await readlink(location);
   if(path.isAbsolute(link))throw Error('Official runtime tree contains an absolute symbolic link.');
   inside(stage,path.resolve(path.dirname(location),link));
  }else if(entry.isDirectory())await verifyProgramTree(location,stage);
  else if(entry.isFile()){
   const info=await lstat(location);await chmod(location,info.mode&0o111?0o755:0o644);
  }else throw Error('Official runtime tree contains an unsupported special file.');
 }
}
for(const target of targets) {
 const archive=path.join(work,target.file);
 let bytes;try{bytes=await readFile(archive);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!bytes||createHash('sha256').update(bytes).digest('hex')!==target.sha256) {
  const response=await fetch(target.url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`Official ${target.dir} download failed (${response.status}).`);
  const maximum=512*1024*1024;let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>maximum)throw Error('Official runtime archive exceeds the download limit.');chunks.push(chunk);}
  bytes=Buffer.concat(chunks,size);
  if(createHash('sha256').update(bytes).digest('hex')!==target.sha256)throw Error(`Official ${target.dir} archive checksum mismatch.`);
  await writeFile(archive,bytes,{mode:0o600});
 }
 const listed=await run('tar',['-tzf',archive],{timeout:30000,maxBuffer:32*1024*1024});
 const entries=listed.stdout.split(/\r?\n/).filter(Boolean);validateNativeArchiveEntries(entries,target);
 const stage=await mkdtemp(path.join(work,`${target.dir}-`));inside(work,stage);await chmod(stage,0o700);
 await run('tar',['-xzf',archive,'-C',stage,'--strip-components=1'],{timeout:60000,maxBuffer:16384});
 if(target.dir==='cua-driver'){
  const skillFiles=['BROWSER.md','EMBEDDING.md','README.md','RECORDING.md','RUNTIME.md','SKILL.md','VISUAL.md','WINDOWS.md','WORKFLOW.md','MACOS.md','LINUX.md','native-guides-provenance.json'];
  const source=path.join(vendor,'cua-driver','skills','cua-driver'),destination=path.join(stage,'skills','cua-driver');
  await mkdir(destination,{recursive:true});
  for(const file of skillFiles){const original=path.join(source,file);if(!(await lstat(original)).isFile())throw Error('The bundled Cua program skill must be a regular source file.');await copyFile(original,path.join(destination,file));}
 }
 await verifyProgramTree(stage,stage);
 await stat(path.join(stage,...target.executable.split('/')));
 await writeFile(path.join(stage,'provenance.json'),JSON.stringify({version:target.version,platform:process.platform,arch:process.arch,
   url:target.url,archiveSha256:target.sha256,transformation:'Archive prefix removed; official program bytes, relative symlinks and notices retained. Program directories/readability normalized for installation; existing checked-in Cua skill retained.'},null,2)+'\n');
 await chmod(path.join(stage,'provenance.json'),0o644);
 // Program artifacts must remain readable after a system package installs them
 // as root. The download/work directory remains private to the build account.
 await chmod(stage,0o755);
 const destination=path.join(vendor,target.dir);inside(vendor,destination);
 const current=await lstat(destination).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
 if(current?.isSymbolicLink())throw Error('Refusing to replace a linked runtime directory.');
 if(current){const backup=path.join(work,`previous-${target.dir}-${randomUUID()}`);inside(work,backup);await rename(destination,backup);}
 await rename(stage,destination);
 console.log(`Prepared verified ${target.dir} ${target.version} for ${process.platform}/${process.arch}.`);
}
