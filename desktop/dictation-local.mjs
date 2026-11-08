import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,rmdir,readFile,writeFile,rename,rm,stat,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {cpus} from 'node:os';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {inflateRawSync} from 'node:zlib';
import {assertDiskSpace} from './disk-guard.mjs';

// Official MIT whisper.cpp CPU release and MIT Whisper multilingual base weights.
// Nothing downloads or opens the microphone until the owner explicitly chooses it.
export const LOCAL_DICTATION_ASSETS=Object.freeze({
  runtime:{url:'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',sha256:'6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',size:8928640},
  model:{url:'https://huggingface.co/ggerganov/whisper.cpp/resolve/80da2d8bfee42b0e836fc3a9890373e5defc00a6/ggml-base.bin',sha256:'60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',size:147951465},
  version:'1.9.5',release:'b5454',license:'MIT',modelName:'Whisper multilingual base',
});
const files={
  'whisper-cli.exe':['331dba46d6427105d2b802cdbc7eae916ea1c5abf9b0d3b5cfe460d8db8e4366',479744],
  'whisper.dll':['034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674',1370112],
  'ggml.dll':['31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e',62464],
  'ggml-base.dll':['bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0',693248],
  'ggml-cpu-alderlake.dll':['d8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603',1009664],
  'ggml-cpu-cannonlake.dll':['74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507',1049600],
  'ggml-cpu-cascadelake.dll':['4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e',1061376],
  'ggml-cpu-haswell.dll':['1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b',1010688],
  'ggml-cpu-icelake.dll':['2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40',1061376],
  'ggml-cpu-sandybridge.dll':['04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e',1026560],
  'ggml-cpu-skylakex.dll':['1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be',1049600],
  'ggml-cpu-sse42.dll':['f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a',862720],
  'ggml-cpu-x64.dll':['4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3',866816],
};
export const LOCAL_DICTATION_FILES=Object.freeze(files);
const checksum=async file=>{const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');};
const expected=[...Object.entries(files).map(([name,[sha256,size]])=>({name,sha256,size})),{name:'ggml-base.bin',...LOCAL_DICTATION_ASSETS.model}];

async function checkedFile(root,file){
  const target=path.join(root,file.name),entry=await lstat(target);
  if(!entry.isFile()||entry.isSymbolicLink()||entry.size!==file.size||await checksum(target)!==file.sha256)throw Error('Local dictation files changed or are incomplete. Download them again.');
  return target;
}

/** Extract only pinned files from a hash-checked ZIP. No paths or executables from user input. */
export function extractDictationRuntime(bytes){
  const result=new Map();let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--)if(bytes.readUInt32LE(at)===0x06054b50){end=at;break;}
  if(end<0)throw Error('Invalid dictation runtime archive.');
  const count=bytes.readUInt16LE(end+10);let at=bytes.readUInt32LE(end+16);
  for(let i=0;i<count;i++){
    if(at+46>bytes.length||bytes.readUInt32LE(at)!==0x02014b50)throw Error('Invalid runtime ZIP directory.');
    const method=bytes.readUInt16LE(at+10),packed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24),nameLength=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8');at+=46+nameLength+extra+comment;
    const base=name.startsWith('Release/')?name.slice(8):'';if(!Object.hasOwn(files,base))continue;
    if(result.has(base)||size!==files[base][1]||offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)throw Error('Unexpected runtime ZIP entry.');
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);if(start+packed>bytes.length)throw Error('Truncated runtime archive.');
    const body=bytes.subarray(start,start+packed),data=method===0?body:method===8?inflateRawSync(body,{maxOutputLength:size}):null;
    if(!data||data.length!==size||createHash('sha256').update(data).digest('hex')!==files[base][0])throw Error('Runtime contents failed integrity verification.');
    result.set(base,data);
  }
  if(result.size!==Object.keys(files).length)throw Error('Runtime archive is missing required files.');return result;
}

async function download(asset,target,{fetchImpl,signal,onProgress}){
  const existing=await stat(target).catch(()=>null);if(existing?.size===asset.size&&await checksum(target)===asset.sha256){onProgress(asset.size);return;}
  const response=await fetchImpl(asset.url,{signal,redirect:'follow'});if(!response.ok||!response.body)throw Error(`Local dictation download failed (${response.status}).`);
  let total=0;const hash=createHash('sha256'),partial=target+'.part';
  const meter=new Transform({transform(chunk,_encoding,callback){total+=chunk.length;if(total>asset.size){callback(Error('Dictation download exceeds its expected size.'));return;}hash.update(chunk);onProgress(total);callback(null,chunk);}});
  try{await pipeline(typeof response.body.getReader==='function'?Readable.fromWeb(response.body):response.body,meter,createWriteStream(partial,{mode:0o600}),{signal});if(total!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('Dictation download failed its integrity check.');await rename(partial,target);}
  catch(error){await rm(partial,{force:true}).catch(()=>{});throw error;}
}

export async function installLocalDictation(root,{fetchImpl=fetch,signal,onProgress=()=>{},platform=process.platform,arch=process.arch}={}){
  if(platform!=='win32'||arch!=='x64')throw Error('This local dictation package currently supports Windows x64.');
  await mkdir(root,{recursive:true});await assertDiskSpace(root,210_000_000,{label:'Downloading local dictation'});
  const runtime=path.join(root,'runtime.zip');let done=0;
  await download(LOCAL_DICTATION_ASSETS.runtime,runtime,{fetchImpl,signal,onProgress:n=>onProgress(n)});done=LOCAL_DICTATION_ASSETS.runtime.size;
  const extracted=extractDictationRuntime(await readFile(runtime));
  for(const [name,bytes]of extracted)await writeFile(path.join(root,name),bytes,{mode:0o600});
  await download(LOCAL_DICTATION_ASSETS.model,path.join(root,'ggml-base.bin'),{fetchImpl,signal,onProgress:n=>onProgress(done+n)});
  for(const file of expected)await checkedFile(root,file);
  await writeFile(path.join(root,'installed.json'),JSON.stringify({release:LOCAL_DICTATION_ASSETS.release,model:LOCAL_DICTATION_ASSETS.model.sha256,at:new Date().toISOString()}),'utf8');
  await rm(runtime,{force:true});return {installed:true};
}

export class LocalDictation {
  constructor({root,emit=()=>{},spawnImpl=spawn,platform=process.platform,arch=process.arch,verifyImpl=null}={}){Object.assign(this,{root,emit,spawnImpl,platform,arch,verifyImpl});this.active=null;this.starting=false;this.closing=new Set();this.generation=0;this.download=null;this.closed=false;this.cleanupWarning='';this.recovery=this.cleanupCaptures().catch(()=>{this.cleanupWarning='A previous temporary recording could not be removed. Try local dictation again to retry cleanup.';});}
  get busy(){return !!(this.active||this.starting||this.closing.size||this.download?.controller);}
  async status(){
    await this.recovery;
    const supported=this.platform==='win32'&&this.arch==='x64';let installed=false;
    if(supported)try{const marker=JSON.parse(await readFile(path.join(this.root,'installed.json'),'utf8'));installed=marker.release===LOCAL_DICTATION_ASSETS.release&&marker.model===LOCAL_DICTATION_ASSETS.model.sha256&&(await Promise.all(expected.map(file=>lstat(path.join(this.root,file.name)).then(entry=>entry.isFile()&&!entry.isSymbolicLink()&&entry.size===file.size).catch(()=>false)))).every(Boolean);}catch{}
    return {supported,installed,active:!!this.active,cleanupWarning:this.cleanupWarning,download:this.download?{running:!!this.download.controller,done:this.download.done,total:LOCAL_DICTATION_ASSETS.runtime.size+LOCAL_DICTATION_ASSETS.model.size,error:this.download.error||''}:null,model:LOCAL_DICTATION_ASSETS.modelName,license:'MIT',downloadBytes:LOCAL_DICTATION_ASSETS.runtime.size+LOCAL_DICTATION_ASSETS.model.size,memoryMb:400,threads:Math.max(1,Math.min(4,Math.floor(cpus().length/4)))};
  }
  async install({fetchImpl=fetch}={}){
    if(this.closed)throw Error('Local dictation has closed.');if(this.busy)throw Error('Stop local dictation and wait for it to finish before downloading.');
    const controller=new AbortController(),job={controller,done:0,error:''};this.download=job;
    try{await installLocalDictation(this.root,{fetchImpl,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15*60_000)]),platform:this.platform,arch:this.arch,onProgress:done=>{job.done=done;}});}
    catch(error){job.error=controller.signal.aborted?'Download cancelled.':String(error.message).slice(0,500);throw error;}
    finally{job.controller=null;}return this.status();
  }
  cancelDownload(){this.download?.controller?.abort();return {cancelled:true};}
  async remove(){this.stop();if(this.download?.controller)throw Error('Cancel the download before removing local dictation.');await this.settled();for(const name of [...Object.keys(files),'ggml-base.bin','installed.json','runtime.zip','runtime.zip.part','ggml-base.bin.part'])await rm(path.join(this.root,name),{force:true});return this.status();}
  async verify(){if(this.verifyImpl)return this.verifyImpl();for(const file of expected)await checkedFile(this.root,file);const allowed=new Set([...Object.keys(files),'ggml-base.bin','installed.json']);for(const name of await readdir(this.root))if(/\.(?:dll|exe)$/i.test(name)&&!allowed.has(name))throw Error('Unexpected executable file in local dictation. Remove and download the engine again.');}
  async cleanupCaptures(){
    if(this.active)return;
    for(const entry of await readdir(this.root,{withFileTypes:true}).catch(()=>[]))if(/^capture-[A-Za-z0-9]{6}$/.test(entry.name)&&entry.isDirectory()&&!entry.isSymbolicLink()){
      const dir=path.join(this.root,entry.name),children=await readdir(dir);if(children.some(name=>name!=='input.wav'))continue;
      await rm(path.join(dir,'input.wav'),{force:true});await rmdir(dir);
    }
  }
  mediaAllowed(){return !!(this.active?.ready&&this.active.phase==='capture'&&!this.closed);}
  async start({language='en',conversationId='',projectId=''}={}){
    if(this.closed)throw Error('Local dictation has closed. Reopen Exomina to use it.');
    if(this.platform!=='win32'||this.arch!=='x64')throw Error('Local dictation currently supports Windows x64.');
    const spoken=String(language||'en').split('-')[0];if(!['en','de'].includes(spoken))throw Error('Choose English or German for local dictation.');
    if(this.download?.controller||this.starting)throw Error('Wait for local dictation setup to finish.');
    this.stop();const generation=this.generation;this.starting=true;
    try{await this.recovery;await this.settled();await this.cleanupCaptures();this.cleanupWarning='';await this.verify();if(this.closed||generation!==this.generation||this.download?.controller)throw Error('Local dictation was stopped.');}
    finally{if(generation===this.generation)this.starting=false;}
    const sessionId=randomUUID();this.active={sessionId,language:spoken,conversationId,projectId,mode:'listen',ready:true,phase:'capture',child:null,timer:null};
    return {sessionId,language:spoken,engine:'whisper',capture:true};
  }
  async transcribe({sessionId,wav,conversationId='',projectId=''}={}){
    const state=this.active;
    if(!state||sessionId!==state.sessionId||state.phase!=='capture'||conversationId!==state.conversationId||projectId!==state.projectId)throw Error('Local recording session changed. Start dictation again.');
    if(typeof wav!=='string'||wav.length>5_120_100||!/^[-A-Za-z0-9+/=]+$/.test(wav))throw Error('Recording exceeds the two-minute local limit.');
    const bytes=Buffer.from(wav,'base64');
    if(bytes.length<46||bytes.length>3_840_044||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.toString('ascii',12,16)!=='fmt '||bytes.readUInt32LE(16)!==16||bytes.readUInt16LE(20)!==1||bytes.readUInt16LE(22)!==1||bytes.readUInt32LE(24)!==16000||bytes.readUInt32LE(28)!==32000||bytes.readUInt16LE(32)!==2||bytes.readUInt16LE(34)!==16||bytes.toString('ascii',36,40)!=='data'||bytes.readUInt32LE(40)!==bytes.length-44||bytes.readUInt32LE(4)!==bytes.length-8)throw Error('Expected a bounded 16 kHz mono PCM recording.');
    state.phase='transcribe';state.ready=false;const directory=await mkdtemp(path.join(this.root,'capture-')),input=path.join(directory,'input.wav');
    try{
      await writeFile(input,bytes,{mode:0o600});bytes.fill(0);if(this.active!==state)throw Error('Local dictation was stopped.');
      const text=await new Promise((resolve,reject)=>{
        state.reject=reject;let output='';let closed;state.exit=new Promise(resolve=>closed=resolve);
        state.child=this.spawnImpl(path.join(this.root,'whisper-cli.exe'),['-m',path.join(this.root,'ggml-base.bin'),'-f',input,'-l',state.language,'-t',String(Math.max(1,Math.min(4,Math.floor(cpus().length/4)))),'--no-gpu','--no-fallback','--no-prints','--no-timestamps'],{cwd:this.root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,GGML_BACKEND_PATH:this.root}});
        state.timer=setTimeout(()=>{this.closing.add(state.child);state.child.kill();reject(Error('Local transcription exceeded two minutes.'));},120_000);state.child.stdout.setEncoding('utf8');state.child.stderr.on('data',()=>{});
        state.child.stdout.on('data',chunk=>{output+=chunk;if(output.length>24000){this.closing.add(state.child);state.child.kill();reject(Error('Local transcription exceeded its text limit.'));}});
        state.child.once('error',()=>reject(Error('Local transcription could not start. Remove and download the recognizer again.')));
        state.child.once('close',code=>{state.exited=true;closed();this.closing.delete(state.child);clearTimeout(state.timer);if(this.active!==state)reject(Error('Local dictation was stopped.'));else if(code!==0)reject(Error('Local transcription failed. Try a shorter recording.'));else resolve(output.trim());});
      });
      if(this.active!==state)throw Error('Local dictation was stopped.');return {text};
    }finally{
      bytes.fill(0);clearTimeout(state.timer);
      try{if(state.child&&state.exit){let timer;try{await Promise.race([state.exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Recognizer exit is still pending.')),5000);})]);}finally{clearTimeout(timer);}}await rm(input,{force:true});await rmdir(directory);}
      catch{this.cleanupWarning='A temporary recording remains while its recognizer finishes. It will be removed on the next local start or app launch.';throw Error(this.cleanupWarning);}
    }
  }
  async settled(){await Promise.all([...this.closing].map(child=>new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);resolve();},timer=setTimeout(()=>{child.removeListener('close',done);reject(Error('The previous local recognizer has not exited. Wait before starting another session.'));},5000);child.once('close',done);})));}
  stop(sessionId){if(sessionId&&this.active?.sessionId!==sessionId)return {stopped:false};this.generation++;this.starting=false;const state=this.active;this.active=null;if(state){clearTimeout(state.timer);if(state.child&&!state.exited){this.closing.add(state.child);state.child.kill();}state.reject?.(Error('Local dictation was stopped.'));this.emit({type:'voice.event',sessionId:state.sessionId,mode:'listen',event:{type:'stopped'}});}return {stopped:true};}
  close(){this.closed=true;this.stop();this.cancelDownload();}
}
