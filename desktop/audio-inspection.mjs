import {open,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';

export const AUDIO_LIMITS=Object.freeze({fileBytes:128*1024*1024,samples:32000000,durationSeconds:1800,chunks:10000,bufferBytes:256*1024});
export const AUDIO_INSPECT_TOOL={name:'audio_inspect',description:'Measure a local workspace WAV after read approval: duration, channels, sample rate, sample peak, RMS, DC offset, full-scale samples and quiet intervals. Reads PCM/IEEE-float RIFF WAV in bounded chunks, without a model, playback, microphone or upload. This does not hear, transcribe or judge sound quality; LUFS and true peak are not measured. MP3, video and compressed WAV are unsupported.',inputSchema:{type:'object',properties:{path:{type:'string',description:'Relative path to a WAV in this chat’s selected workspace.'}},required:['path'],additionalProperties:false}};
const inside=(root,file)=>{const part=path.relative(root,file);return part===''||(!part.startsWith('..'+path.sep)&&part!=='..'&&!path.isAbsolute(part));};
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const db=value=>value>0?20*Math.log10(value):null;
const sensitive=value=>value.split(/[\\/]/).some(part=>/^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.codex|\.claude|\.gemini|accounts|credentials|sessions|cookies|local storage|session storage)$/i.test(part)||/^\.env(?:\.|$)/i.test(part));

async function regularPath(workspaceTools,relative){
 if(typeof relative!=='string'||!relative.trim()||path.isAbsolute(relative)||relative.includes(':')||relative.includes('\0')||relative.split(/[\\/]/).includes('..'))throw Error('Provide a relative workspace WAV path.');
 if(sensitive(relative))throw Error('Credential and private data paths cannot be inspected as audio.');
 const file=await workspaceTools.target(relative),root=await realpath(workspaceTools.getSettings().workspace);
 if(!inside(root,file))throw Error('Audio path is outside the workspace.');
 let at=file;
 while(!samePath(at,root)){const info=await lstat(at);if(info.isSymbolicLink())throw Error('Audio inspection cannot follow links or junctions.');const parent=path.dirname(at);if(parent===at)throw Error('Audio path is outside the workspace.');at=parent;}
 const info=await lstat(file);if(!info.isFile()||info.nlink!==1)throw Error('Select a regular WAV file without hard links.');
 if(info.size>AUDIO_LIMITS.fileBytes)throw Error('Audio inspection is limited to 128 MiB per file.');
 return {file,info};
}

async function exact(handle,position,size){const buffer=Buffer.alloc(size);let offset=0;while(offset<size){const {bytesRead}=await handle.read(buffer,offset,size-offset,position+offset);if(!bytesRead)throw Error('Truncated WAV data.');offset+=bytesRead;}return buffer;}
function format(bytes,declaredLength=bytes.length){
 if(bytes.length<16)throw Error('Truncated WAV format chunk.');
 if(declaredLength>16&&(bytes.length<18||bytes.readUInt16LE(16)>declaredLength-18))throw Error('Truncated WAV format extension.');
 let code=bytes.readUInt16LE(0);const channels=bytes.readUInt16LE(2),sampleRate=bytes.readUInt32LE(4),byteRate=bytes.readUInt32LE(8),blockAlign=bytes.readUInt16LE(12),bits=bytes.readUInt16LE(14);
 if(code===0xfffe){
  if(bytes.length<40||bytes.readUInt16LE(16)<22)throw Error('Truncated extensible WAV format.');
  const validBits=bytes.readUInt16LE(18),guid=bytes.subarray(24,40).toString('hex');
  if(validBits!==bits)throw Error('WAV with reduced valid bits is not supported.');
  if(guid==='0100000000001000800000aa00389b71')code=1;else if(guid==='0300000000001000800000aa00389b71')code=3;else throw Error('Compressed extensible WAV is not supported.');
 }
 if(![1,3].includes(code))throw Error('Compressed WAV is not supported. Use uncompressed PCM or IEEE-float WAV.');
 if(!(code===1?[8,16,24,32]:[32,64]).includes(bits))throw Error('Unsupported PCM or IEEE-float bit depth.');
 if(channels<1||channels>8||sampleRate<1||sampleRate>384000)throw Error('WAV must have 1–8 channels and a sample rate up to 384 kHz.');
 if(blockAlign!==channels*bits/8||byteRate!==sampleRate*blockAlign)throw Error('Inconsistent WAV block alignment or byte rate.');
 return {encoding:code===1?'PCM':'IEEE float',code,channels,sampleRate,bitsPerSample:bits,blockAlign};
}

/** Measurements over the complete declared data chunk, with bounded memory and event-loop yields. */
export async function inspectWavHandle(handle,size,{check=()=>{}}={}){
 check();if(size>AUDIO_LIMITS.fileBytes)throw Error('Audio inspection is limited to 128 MiB per file.');
 const header=await exact(handle,0,12);
 if(header.toString('latin1',0,4)!=='RIFF'||header.toString('latin1',8,12)!=='WAVE')throw Error('Only little-endian RIFF WAV is supported; MP3, video, RF64 and RIFX are unsupported.');
 const end=header.readUInt32LE(4)+8;if(end<12||end>size)throw Error('Truncated or invalid RIFF length.');
 let position=12,fmt=null,data=null,count=0;
 while(position<end){
  check();if(++count>AUDIO_LIMITS.chunks)throw Error('WAV contains too many chunks.');if(position+8>end)throw Error('Truncated WAV chunk header.');
  const chunk=await exact(handle,position,8),id=chunk.toString('latin1',0,4),length=chunk.readUInt32LE(4),start=position+8,next=start+length+(length%2);
  if(next>end)throw Error('Truncated WAV chunk or padding.');
  if(id==='fmt '){if(fmt)throw Error('Multiple WAV format chunks are unsupported.');fmt=format(await exact(handle,start,Math.min(length,40)),length);}
  if(id==='data'){if(data)throw Error('Multiple WAV data chunks are unsupported.');data={start,length};}
  position=next;
 }
 if(!fmt||!data)throw Error('WAV needs both format and data chunks.');
 if(data.length%fmt.blockAlign!==0)throw Error('WAV data ends inside a sample frame.');
 const frames=data.length/fmt.blockAlign,duration=frames/fmt.sampleRate;
 if(duration>AUDIO_LIMITS.durationSeconds||frames*fmt.channels>AUDIO_LIMITS.samples)throw Error('Audio inspection is limited to 30 minutes and 32 million channel samples.');
 const stats=Array.from({length:fmt.channels},()=>({peak:0,sum:0,squares:0,fullScaleSamples:0})),width=fmt.bitsPerSample/8;
 const quietThreshold=.001,positiveRail=fmt.code===1?1-1/(2**(fmt.bitsPerSample-1)):1;
 let quietFrames=0,currentQuiet=0,longestQuiet=0;
 const buffer=Buffer.alloc(Math.max(fmt.blockAlign,Math.floor(AUDIO_LIMITS.bufferBytes/fmt.blockAlign)*fmt.blockAlign));
 for(let consumed=0;consumed<data.length;){
  check();const length=Math.min(buffer.length,data.length-consumed);let filled=0;
  while(filled<length){const {bytesRead}=await handle.read(buffer,filled,length-filled,data.start+consumed+filled);if(!bytesRead)throw Error('Truncated WAV samples.');filled+=bytesRead;}
  for(let frame=0;frame<length;frame+=fmt.blockAlign){let quiet=true;
   for(let ch=0;ch<fmt.channels;ch++){const at=frame+ch*width;let value;
    if(fmt.code===3)value=width===4?buffer.readFloatLE(at):buffer.readDoubleLE(at);
    else if(width===1)value=(buffer[at]-128)/128;
    else if(width===2)value=buffer.readInt16LE(at)/32768;
    else if(width===3)value=buffer.readIntLE(at,3)/8388608;
    else value=buffer.readInt32LE(at)/2147483648;
    if(!Number.isFinite(value)||Math.abs(value)>1e6)throw Error('WAV contains non-finite or invalid normalized float samples.');
    const s=stats[ch],absolute=Math.abs(value);s.peak=Math.max(s.peak,absolute);s.sum+=value;s.squares+=value*value;if(value<=-1||value>=positiveRail)s.fullScaleSamples++;if(absolute>quietThreshold)quiet=false;
   }
   if(quiet){quietFrames++;currentQuiet++;longestQuiet=Math.max(longestQuiet,currentQuiet);}else currentQuiet=0;
  }
  consumed+=length;await yieldTurn();
 }
 check();const channels=stats.map((s,index)=>{const rms=frames?Math.sqrt(s.squares/frames):0;return {channel:index+1,samplePeak:s.peak,samplePeakDbfs:db(s.peak),rms,rmsDbfs:db(rms),dcOffset:frames?s.sum/frames:0,fullScaleSamples:s.fullScaleSamples,fullScalePercent:frames?s.fullScaleSamples*100/frames:0};});
 return {format:{encoding:fmt.encoding,channels:fmt.channels,sampleRate:fmt.sampleRate,bitsPerSample:fmt.bitsPerSample},fileBytes:size,dataBytes:data.length,frames,durationSeconds:duration,channels,quiet:{thresholdDbfs:-60,durationSeconds:quietFrames/fmt.sampleRate,longestIntervalSeconds:longestQuiet/fmt.sampleRate,definition:'Every channel sample in a frame has absolute amplitude at or below -60 dBFS.'},possibleClipping:channels.some(s=>s.fullScaleSamples>0),trailingBytes:size-end,limitations:['Signal measurements only: no listening, transcription or semantic/audio-quality judgment.','RMS is unweighted. LUFS, true peak and intersample clipping are not measured.','Full-scale samples indicate possible clipping; they do not establish audible distortion.','A null dBFS value represents zero amplitude (negative infinity).',...(size>end?['Bytes after the declared RIFF container were not interpreted.']:[])]};
}

export class AudioInspectionTools{
 constructor({workspaceTools,approve,live=()=>true}){Object.assign(this,{workspaceTools,approve,live});this.active=new Set();}
 get definitions(){return [AUDIO_INSPECT_TOOL];}
 async call(args={},conversationId){
  if(!args||typeof args!=='object'||Object.keys(args).some(key=>key!=='path'))throw Error('Supply only the workspace audio path.');
  let activeFile;
  const check=()=>{if(!this.live(conversationId,activeFile))throw Error('This chat has stopped or file access changed; audio inspection was cancelled.');};
  check();if(this.active.has(conversationId)||this.active.size>=2)throw Error('Audio inspection is already busy. Wait for the current inspection.');
  this.active.add(conversationId);let handle;
  try{
   const initial=await regularPath(this.workspaceTools,args.path);
   activeFile=initial.file;check();
   if(!await this.approve({title:'Inspect local audio?',detail:`Measure ${initial.file}\n\nReads the WAV locally and shares measurements with the assistant. No playback, microphone, audio upload or model is used.`,conversationId,action:{kind:'read',tool:'audio_inspect',target:initial.file},input:args}))throw Error('Audio inspection was declined.');
   check();const current=await regularPath(this.workspaceTools,args.path);if(current.file!==initial.file||!same(initial.info,current.info))throw Error('The audio file changed while approval was open.');
   handle=await open(current.file,'r');if(!same(current.info,await handle.stat()))throw Error('The audio file changed before it could be read.');
   const result=await inspectWavHandle(handle,current.info.size,{check});
   const after=await regularPath(this.workspaceTools,args.path);if(after.file!==current.file||!same(current.info,after.info)||!same(current.info,await handle.stat()))throw Error('The audio file changed during inspection.');
   check();return {path:args.path,...result};
  }finally{try{await handle?.close();}finally{this.active.delete(conversationId);}}
 }
}
