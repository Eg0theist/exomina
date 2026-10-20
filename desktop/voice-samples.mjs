import {mkdir,readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Voice preview recordings belong to OpenAI and Anthropic, so the shared beta cannot
 * ship them. This module copies them from the user's own installed Codex and Claude
 * desktop apps into Exomina's private data folder, on request. Nothing is uploaded.
 * Only program asset folders are read; no account, token or settings store is opened.
 */

const NAME=/^[a-z][a-z0-9-]{1,30}$/;
const CLIP_ID=/^(?:claude:)?[a-z][a-z0-9-]{1,30}$/;
const STORED_FILE=/^(?:chatgpt|chatgpt-clear|claude)\/[a-z][a-z0-9-]{1,30}\.(?:wav|mp3)$/;
const CODEX_WAV=/^([a-z][a-z0-9-]{1,30})\.en\.([0-9a-f]{8})-[0-9a-f]{6,16}\.wav$/;
const MAX_CLIPS=30,MAX_WAV=8*1024*1024,MAX_MP3=4*1024*1024;

// Relative to an app's install folder (or to a folder the user picks). Electron reads app.asar like a folder.
export const CODEX_ASSET_DIRS=Object.freeze([
  'app/resources/app.asar/webview/assets','app/resources/app.asar.unpacked/webview/assets',
  'resources/app.asar/webview/assets','Contents/Resources/app.asar/webview/assets','Contents/Resources/app.asar.unpacked/webview/assets',
  'app.asar/webview/assets','webview/assets'
]);
export const CLAUDE_SAMPLE_DIRS=Object.freeze([
  'app/resources/ion-dist/audio/voice/selection','resources/ion-dist/audio/voice/selection','Contents/Resources/ion-dist/audio/voice/selection',
  'ion-dist/audio/voice/selection','audio/voice/selection'
]);

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

// ---- "Clear" sample sound: the gentle tonal adjustment of the personal build, computed on this computer. ----
// Standard RBJ biquads in Float64, linear gain, one final PCM16 quantization. No compression, speed or pitch change.
const CLEAR_PROFILE=Object.freeze([
  {type:'peaking',frequency:300,q:0.8,gainDb:-2.5},
  {type:'peaking',frequency:3000,q:0.9,gainDb:2.5},
  {type:'highshelf',frequency:6500,slope:1,gainDb:1}
]);
const CEILING_DB=-1.2,MAX_GAIN_DB=2;

function decodeWav(bytes){
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('Not a WAV recording.');
  let format,dataOffset,dataLength;
  for(let offset=12;offset+8<=bytes.length;){
    const id=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4);
    if(offset+8+length>bytes.length)throw Error('Truncated WAV chunk.');
    if(id==='fmt '&&length>=16)format={format:bytes.readUInt16LE(offset+8),channels:bytes.readUInt16LE(offset+10),sampleRate:bytes.readUInt32LE(offset+12),bits:bytes.readUInt16LE(offset+22)};
    if(id==='data'){dataOffset=offset+8;dataLength=length;}
    offset+=8+length+(length%2);
  }
  if(!format||format.format!==1||format.channels!==1||format.bits!==16||format.sampleRate<8000||format.sampleRate>96000)throw Error('Unsupported WAV format.');
  if(dataOffset===undefined||!dataLength||dataLength%2)throw Error('Missing WAV audio.');
  const samples=new Float64Array(dataLength/2);
  for(let index=0;index<samples.length;index++)samples[index]=bytes.readInt16LE(dataOffset+index*2)/32768;
  return {format,dataOffset,samples};
}

function coefficients(filter,sampleRate){
  const omega=2*Math.PI*filter.frequency/sampleRate,cos=Math.cos(omega),sin=Math.sin(omega),a=Math.pow(10,filter.gainDb/40);
  let b0,b1,b2,a0,a1,a2;
  if(filter.type==='peaking'){
    const alpha=sin/(2*filter.q);
    b0=1+alpha*a;b1=-2*cos;b2=1-alpha*a;a0=1+alpha/a;a1=-2*cos;a2=1-alpha/a;
  }else{
    const alpha=sin/2*Math.sqrt((a+1/a)*(1/filter.slope-1)+2),beta=2*Math.sqrt(a)*alpha;
    b0=a*((a+1)+(a-1)*cos+beta);b1=-2*a*((a-1)+(a+1)*cos);b2=a*((a+1)+(a-1)*cos-beta);
    a0=(a+1)-(a-1)*cos+beta;a1=2*((a-1)-(a+1)*cos);a2=(a+1)-(a-1)*cos-beta;
  }
  return {b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:a1/a0,a2:a2/a0};
}

function filterSamples(samples,c){
  const result=new Float64Array(samples.length);
  let x1=0,x2=0,y1=0,y2=0;
  for(let index=0;index<samples.length;index++){
    const x=samples[index],y=c.b0*x+c.b1*x1+c.b2*x2-c.a1*y1-c.a2*y2;
    result[index]=y;x2=x1;x1=x;y2=y1;y1=y;
  }
  return result;
}

function levels(samples){
  let energy=0,peak=0;
  for(const sample of samples){
    if(!Number.isFinite(sample))throw Error('Nonfinite filtered sample.');
    energy+=sample*sample;peak=Math.max(peak,Math.abs(sample));
  }
  const rms=Math.sqrt(energy/samples.length);
  if(!(rms>0)||!(peak>0))throw Error('Silent recording.');
  return {rmsDb:20*Math.log10(rms),peak};
}

/** The same tonal adjustment as the personal build's Clear samples, applied to one original WAV. */
export function clearWav(original){
  const {format,dataOffset,samples}=decodeWav(original),before=levels(samples);
  let filtered=samples;
  for(const filter of CLEAR_PROFILE)filtered=filterSamples(filtered,coefficients(filter,format.sampleRate));
  const after=levels(filtered),ceiling=Math.pow(10,CEILING_DB/20);
  const gainDb=Math.min(MAX_GAIN_DB,before.rmsDb-after.rmsDb,20*Math.log10(ceiling/after.peak)),gain=Math.pow(10,gainDb/20);
  const derived=Buffer.from(original);
  for(let index=0;index<filtered.length;index++)derived.writeInt16LE(Math.round(filtered[index]*gain*32768),dataOffset+index*2);
  return derived;
}

// ---- Finding the user's installed apps ----
const APPX_SCRIPT="Get-AppxPackage | Where-Object { $_.Name -in 'OpenAI.Codex','Claude' } | ForEach-Object { $_.Name + '|' + $_.Version + '|' + $_.InstallLocation }";

function runFile(file,args){
  return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:20000,maxBuffer:1<<20},(error,stdout)=>error?reject(error):resolve(String(stdout))));
}

/** Install folders of the user's own Codex and Claude desktop apps (read-only discovery). */
export async function installedApps({platform=process.platform,run=runFile,home=os.homedir(),env=process.env}={}){
  if(platform==='win32'){
    const shell=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    let output='';try{output=await run(shell,['-NoProfile','-NonInteractive','-Command',APPX_SCRIPT]);}catch{return [];}
    const apps=[];
    for(const line of output.split(/\r?\n/)){
      const [name,version,root]=line.trim().split('|');
      if(!['OpenAI.Codex','Claude'].includes(name)||!root||!path.win32.isAbsolute(root)||!/\\WindowsApps\\/i.test(root)||!/^[\d.]{1,40}$/.test(version||''))continue;
      apps.push({app:name==='Claude'?'Claude':'Codex',version,root});
    }
    return apps;
  }
  if(platform==='darwin')return ['/Applications','/Applications/OpenAI',path.join(home,'Applications')].flatMap(base=>[['Codex','Codex.app'],['Codex','ChatGPT.app'],['Claude','Claude.app']].map(([app,bundle])=>({app,version:'',root:path.join(base,bundle)})));
  return [];
}

async function listFiles(dir,listDir){
  try{return (await listDir(dir)).filter(name=>typeof name==='string');}catch{return [];}
}

/** Read recognizable voice recordings below one app folder. Returns the clips and a count of rejected files. */
async function scanRoot(root,{listDir,readBytes}){
  const chatgpt=new Map(),claude=new Map();let rejected=0;
  for(const relative of CODEX_ASSET_DIRS){
    const dir=path.join(root,relative);
    for(const name of await listFiles(dir,listDir)){
      const match=CODEX_WAV.exec(name);if(!match||chatgpt.size>=MAX_CLIPS)continue;
      let bytes;try{bytes=await readBytes(path.join(dir,name));}catch{rejected++;continue;}
      // The file name embeds the start of the content hash, so a damaged or altered file is detected.
      if(bytes.length>MAX_WAV||!sha256(bytes).startsWith(match[2])){rejected++;continue;}
      try{decodeWav(bytes);}catch{rejected++;continue;}
      if(!chatgpt.has(match[1]))chatgpt.set(match[1],bytes);
    }
  }
  for(const relative of CLAUDE_SAMPLE_DIRS){
    const dir=path.join(root,relative);
    for(const name of await listFiles(dir,listDir)){
      const match=/^([a-z][a-z0-9-]{1,30})\.mp3$/.exec(name);if(!match||claude.size>=MAX_CLIPS)continue;
      let bytes;try{bytes=await readBytes(path.join(dir,name));}catch{rejected++;continue;}
      const framed=bytes.length>1000&&(bytes.toString('latin1',0,3)==='ID3'||(bytes[0]===0xFF&&(bytes[1]&0xE0)===0xE0));
      if(bytes.length>MAX_MP3||!framed){rejected++;continue;}
      if(!claude.has(match[1]))claude.set(match[1],bytes);
    }
  }
  return {chatgpt,claude,rejected};
}

export class VoiceSamples {
  constructor({dir,findApps=installedApps,listDir=readdir,readBytes=readFile,now=()=>new Date()}){
    Object.assign(this,{dir:path.resolve(dir),findApps,listDir,readBytes,now});this.pending=null;
  }
  async manifest(){
    try{
      const value=JSON.parse(await readFile(path.join(this.dir,'manifest.json'),'utf8'));
      if(value?.version!==1||!value.clips||typeof value.clips!=='object')return null;
      return value;
    }catch{return null;}
  }
  async status(){
    const manifest=await this.manifest();
    if(!manifest)return {imported:false,chatgpt:[],claude:[],clear:false,importedAt:'',sources:[]};
    const ids=Object.keys(manifest.clips).filter(id=>CLIP_ID.test(id));
    const chatgpt=ids.filter(id=>manifest.clips[id]?.kind==='chatgpt'),claude=ids.filter(id=>manifest.clips[id]?.kind==='claude').map(id=>id.slice(7));
    return {imported:chatgpt.length+claude.length>0,chatgpt,claude,clear:chatgpt.some(id=>manifest.clips[id].clear),importedAt:String(manifest.importedAt||''),
      sources:(Array.isArray(manifest.sources)?manifest.sources:[]).slice(0,4).map(item=>({app:String(item?.app||'').slice(0,20),version:String(item?.version||'').slice(0,40)}))};
  }
  /** Copy recordings from the user's apps (or from a folder the user chose). Existing samples stay if nothing new is found. */
  import({folder}={}){
    if(this.pending)return this.pending;
    this.pending=this.#import(folder).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async #import(folder){
    const roots=folder?[{app:'Selected folder',version:'',root:path.resolve(String(folder))}]:await this.findApps();
    const chatgpt=new Map(),claude=new Map(),sources=[];let rejected=0;
    for(const item of roots){
      const found=await scanRoot(item.root,this);rejected+=found.rejected;
      let used=false;
      for(const [id,bytes] of found.chatgpt)if(!chatgpt.has(id)){chatgpt.set(id,bytes);used=true;}
      for(const [id,bytes] of found.claude)if(!claude.has(id)){claude.set(id,bytes);used=true;}
      if(used)sources.push({app:item.app,version:item.version});
    }
    const found={chatgpt:chatgpt.size,claude:claude.size};
    if(!chatgpt.size&&!claude.size)return {...await this.status(),changed:false,found,rejected,message:folder
      ?'No ChatGPT or Claude voice recordings were found in that folder.'
      :'Exomina could not find the Codex or Claude desktop app with voice recordings on this computer.'};
    const staging=this.dir+'.new';
    await rm(staging,{recursive:true,force:true});
    for(const sub of ['chatgpt','chatgpt-clear','claude'])await mkdir(path.join(staging,sub),{recursive:true});
    const clips={};
    const store=async(file,bytes)=>{await writeFile(path.join(staging,file),bytes);return {file,bytes:bytes.length,sha256:sha256(bytes)};};
    for(const [id,bytes] of chatgpt){
      const entry={kind:'chatgpt',original:await store(`chatgpt/${id}.wav`,bytes)};
      try{entry.clear=await store(`chatgpt-clear/${id}.wav`,clearWav(bytes));}catch{/* The original remains playable. */}
      clips[id]=entry;
    }
    for(const [id,bytes] of claude)clips['claude:'+id]={kind:'claude',original:await store(`claude/${id}.mp3`,bytes)};
    await writeFile(path.join(staging,'manifest.json'),JSON.stringify({version:1,importedAt:this.now().toISOString(),sources,clips},null,1)+'\n');
    await rm(this.dir,{recursive:true,force:true});
    await mkdir(path.dirname(this.dir),{recursive:true});
    await rename(staging,this.dir);
    return {...await this.status(),changed:true,found,rejected,message:''};
  }
  /** One recording as base64 for the renderer, after re-checking it against its recorded hash. */
  async read(id,tone='original'){
    if(typeof id!=='string'||!CLIP_ID.test(id))throw Error('Invalid voice sample.');
    const manifest=await this.manifest(),clip=manifest&&Object.hasOwn(manifest.clips,id)?manifest.clips[id]:null;
    if(!clip)return null;
    const entry=tone==='clear'&&clip.clear?clip.clear:clip.original;
    if(!entry||!STORED_FILE.test(entry.file||''))throw Error('The saved voice sample is invalid.');
    const bytes=await readFile(path.join(this.dir,...entry.file.split('/')));
    if(sha256(bytes)!==entry.sha256)throw Error('The saved voice sample was changed. Add the voice previews again.');
    return {type:entry.file.endsWith('.mp3')?'audio/mpeg':'audio/wav',data:bytes.toString('base64')};
  }
  async remove(){
    await rm(this.dir,{recursive:true,force:true});await rm(this.dir+'.new',{recursive:true,force:true});
    return this.status();
  }
}
