import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,open,rm,symlink,link,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AUDIO_LIMITS,AUDIO_INSPECT_TOOL,AudioInspectionTools,inspectWavHandle} from '../desktop/audio-inspection.mjs';
import {WorkspaceTools} from '../desktop/workspace-tools.mjs';

function chunk(id,data){const head=Buffer.alloc(8);head.write(id);head.writeUInt32LE(data.length,4);return Buffer.concat([head,data,...(data.length%2?[Buffer.alloc(1)]:[])]);}
function wav({code=1,bits=16,channels=1,rate=8000,samples=[0,0],extras=[],extensible=false,validBits=bits}={}){
 const width=bits/8,data=Buffer.alloc(samples.length*width);
 samples.forEach((value,i)=>{const at=i*width;if(code===3){if(width===4)data.writeFloatLE(value,at);else data.writeDoubleLE(value,at);}else if(width===1)data[at]=value+128;else if(width===2)data.writeInt16LE(value,at);else if(width===3)data.writeIntLE(value,at,3);else data.writeInt32LE(value,at);});
 const fmt=Buffer.alloc(extensible?40:16);fmt.writeUInt16LE(extensible?0xfffe:code);fmt.writeUInt16LE(channels,2);fmt.writeUInt32LE(rate,4);fmt.writeUInt32LE(rate*channels*width,8);fmt.writeUInt16LE(channels*width,12);fmt.writeUInt16LE(bits,14);
 if(extensible){fmt.writeUInt16LE(22,16);fmt.writeUInt16LE(validBits,18);Buffer.from(code===3?'0300000000001000800000aa00389b71':'0100000000001000800000aa00389b71','hex').copy(fmt,24);}
 const body=Buffer.concat([Buffer.from('WAVE'),...extras,chunk('fmt ',fmt),chunk('data',data)]),head=Buffer.alloc(8);head.write('RIFF');head.writeUInt32LE(body.length,4);return Buffer.concat([head,body]);
}
async function fixture(t,{approve=async()=>true,live=()=>true}={}){
 const base=await mkdtemp(path.join(tmpdir(),'exomina-audio-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const workspace=path.join(base,'workspace'),dataDir=path.join(base,'private');await mkdir(workspace);await mkdir(dataDir);let settings={workspace};const approvals=[];
 const workspaceTools=new WorkspaceTools({dataDir,getSettings:()=>settings,approve}),tools=new AudioInspectionTools({workspaceTools,live,approve:async req=>{approvals.push(req);return approve(req);}});
 const put=async(bytes=wav(),name='sample.wav')=>{await writeFile(path.join(workspace,name),bytes);return name;};
 return {base,workspace,dataDir,tools,approvals,put,setWorkspace:root=>settings={workspace:root}};
}
test('WAV sample measurements separate channels, exact RMS/DC, rails and quiet frames',async t=>{
 const f=await fixture(t),name=await f.put(wav({channels:2,rate:4,samples:[0,0,16384,-16384,32767,-32768,0,0]}));const result=await f.tools.call({path:name},'chat');
 assert.equal(result.durationSeconds,1);assert.equal(result.frames,4);assert.equal(result.channels.length,2);assert.equal(result.channels[1].rms,Math.sqrt(1.25/4));assert.equal(result.channels[1].dcOffset,-.375);assert.equal(result.channels[1].samplePeakDbfs,0);assert.equal(result.channels[0].fullScaleSamples,1);assert.equal(result.possibleClipping,true);assert.equal(result.quiet.durationSeconds,.5);assert.equal(result.quiet.longestIntervalSeconds,.25);assert.equal(f.approvals[0].action.kind,'read');assert.match(f.approvals[0].detail,/No playback/);
});
test('supported integer and float formats are measured, including extensible WAV',async t=>{
 const f=await fixture(t);
 for(const [bits,code,samples]of [[8,1,[-128,0,127]],[24,1,[-8388608,0,8388607]],[32,1,[-2147483648,0,2147483647]],[32,3,[-1,0,.5]],[64,3,[-1,0,.5]]]){await f.put(wav({bits,code,samples,extensible:bits===24||code===3}));const result=await f.tools.call({path:'sample.wav'},'chat');assert.equal(result.channels[0].samplePeak,1);assert.equal(result.frames,3);assert.equal(result.format.bitsPerSample,bits);}
});
test('odd metadata chunks, empty data and trailing bytes are explicit and bounded',async t=>{
 const f=await fixture(t);await f.put(Buffer.concat([wav({samples:[],extras:[chunk('JUNK',Buffer.from('x'))]}),Buffer.from('tail')]));const r=await f.tools.call({path:'sample.wav'},'chat');assert.equal(r.frames,0);assert.equal(r.channels[0].rmsDbfs,null);assert.equal(r.quiet.durationSeconds,0);assert.equal(r.trailingBytes,4);
});
test('container truncation, chunk overruns, missing chunks and bad padding fail explicitly',async t=>{
 const f=await fixture(t);const sample=wav();const noData=sample.subarray(0,36);noData.writeUInt32LE(noData.length-8,4);
 for(const bytes of [Buffer.alloc(2),Buffer.from('not a WAV file'),wav().subarray(0,43),noData,Buffer.from('RIFF\x05\0\0\0WAVE!')]){await f.put(bytes);await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/Truncated|RIFF|needs both/);}
});
test('compressed formats, bad alignment/rate, partial frames and invalid floats are refused',async t=>{
 const f=await fixture(t);const badCode=wav();badCode.writeUInt16LE(2,20);const align=wav();align.writeUInt16LE(3,32);const rate=wav();rate.writeUInt32LE(1,28);const partial=wav({channels:2,samples:[1,2,3]});
 for(const bytes of [badCode,align,rate,partial,wav({code:3,bits:32,samples:[NaN]}),wav({code:3,bits:64,samples:[Infinity]}),wav({extensible:true,validBits:12})]){await f.put(bytes);await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/Compressed|alignment|sample frame|non-finite|valid bits/);}
});
test('duplicate format and data chunks are refused instead of silently omitting audio',async t=>{
 const f=await fixture(t);for(const extra of [chunk('data',Buffer.alloc(2)),chunk('fmt ',wav().subarray(20,36))]){await f.put(wav({extras:[extra]}));await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/Multiple WAV/);}
});
test('file, duration and sample budgets refuse oversized work before sample decoding',async t=>{
 const f=await fixture(t);await f.put(wav());const file=await open(path.join(f.workspace,'sample.wav'),'r+');await file.truncate(AUDIO_LIMITS.fileBytes+1);await file.close();await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/128 MiB/);assert.equal(f.approvals.length,0);
 await f.put(wav({rate:1,samples:new Array(1801).fill(0)}));await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/30 minutes/);
 // A sparse declared PCM8 data chunk exceeds the sample count while staying within the byte cap.
 const bytes=wav({bits:8,samples:[]});bytes.writeUInt32LE(36+AUDIO_LIMITS.samples+2,4);bytes.writeUInt32LE(AUDIO_LIMITS.samples+2,40);await f.put(bytes);const big=await open(path.join(f.workspace,'sample.wav'),'r+');await big.truncate(44+AUDIO_LIMITS.samples+2);await big.close();await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/32 million/);
});
test('read denial, private data and traversal never return measurements',async t=>{
 const f=await fixture(t,{approve:async()=>false});await f.put();await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/declined/);assert.equal(f.tools.active.size,0);
 for(const name of ['../private/x.wav','C:\\outside.wav','.ssh/private.wav'])await assert.rejects(f.tools.call({path:name},'chat'),/relative|private/);
 f.setWorkspace(f.dataDir);await writeFile(path.join(f.dataDir,'sample.wav'),wav());await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/account stores|app data/);
});
test('symlink, junction and hardlink aliases are rejected even inside the workspace',async t=>{
 const f=await fixture(t);await f.put();await symlink(path.join(f.workspace,'sample.wav'),path.join(f.workspace,'linked.wav'),'file');await assert.rejects(f.tools.call({path:'linked.wav'},'chat'),/links|junctions/);
 await link(path.join(f.workspace,'sample.wav'),path.join(f.workspace,'hard.wav'));await assert.rejects(f.tools.call({path:'hard.wav'},'chat'),/hard links/);
 await mkdir(path.join(f.workspace,'folder'));await writeFile(path.join(f.workspace,'folder','x.wav'),wav());await symlink(path.join(f.workspace,'folder'),path.join(f.workspace,'alias'),'junction');await assert.rejects(f.tools.call({path:'alias/x.wav'},'chat'),/links|junctions/);assert.equal(f.approvals.length,0);
});
test('replacement or workspace switch during approval is rejected before decode',async t=>{
 let f;f=await fixture(t,{approve:async()=>{await rename(path.join(f.workspace,'sample.wav'),path.join(f.workspace,'old.wav'));await f.put(wav({samples:[100,200]}));return true;}});await f.put();await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/changed while approval/);
 let g;g=await fixture(t,{approve:async()=>{const alternate=path.join(g.base,'other');await mkdir(alternate);await writeFile(path.join(alternate,'sample.wav'),wav());g.setWorkspace(alternate);return true;}});await g.put();await assert.rejects(g.tools.call({path:'sample.wav'},'chat'),/changed while approval/);
});
test('chat stopping cancels before or during sample work and releases the slot',async t=>{
 let live=true;const f=await fixture(t,{live:()=>live,approve:async()=>{live=false;return true;}});await f.put();await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/cancelled/);assert.equal(f.tools.active.size,0);
 live=true;let checks=0;const h=await open(path.join(f.workspace,'sample.wav'));try{await assert.rejects(inspectWavHandle(h,48,{check:()=>{if(++checks===4)throw Error('cancelled');}}),/cancelled/);}finally{await h.close();}
});
test('descriptor promises measurements only and rejects unsupported tool arguments',async t=>{
 const f=await fixture(t);assert.match(AUDIO_INSPECT_TOOL.description,/does not hear/);assert.equal(AUDIO_INSPECT_TOOL.inputSchema.additionalProperties,false);await assert.rejects(f.tools.call({path:'x.wav',upload:true},'chat'),/only/);
});
test('chunked stereo float measurement retains all samples and agrees with independent sine RMS',async t=>{
 const f=await fixture(t),samples=[];for(let n=0;n<80000;n++){const value=.5*Math.sin(2*Math.PI*n/8);samples.push(value,-value);}
 await f.put(wav({code:3,bits:32,channels:2,samples}));const r=await f.tools.call({path:'sample.wav'},'chat');assert.equal(r.frames,80000);assert.equal(r.durationSeconds,10);assert.ok(Math.abs(r.channels[0].rms-.5/Math.sqrt(2))<1e-7);assert.ok(Math.abs(r.channels[1].dcOffset)<1e-9);assert.equal(r.possibleClipping,false);
 const handle=await open(path.join(f.workspace,'sample.wav'));let checks=0;try{await assert.rejects(inspectWavHandle(handle,(await handle.stat()).size,{check:()=>{if(++checks===5)throw Error('cancel after first sample buffer');}}),/after first/);}finally{await handle.close();}
});
test('an inspection slot blocks overlapping same-chat calls and is released after denial',async t=>{
 let release;const f=await fixture(t,{approve:()=>new Promise(resolve=>{release=resolve;})});await f.put();const first=f.tools.call({path:'sample.wav'},'chat');while(!release)await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/already busy/);release(false);await assert.rejects(first,/declined/);assert.equal(f.tools.active.size,0);
});
test('live policy sees the resolved path and can revoke access between sample buffers',async t=>{
 let calls=0,observed;const f=await fixture(t,{live:(_chat,file)=>{if(file){observed=file;calls++;}return calls<8;}});await f.put(wav({bits:32,code:3,samples:new Array(160000).fill(.25)}));await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/access changed/);assert.equal(observed,path.join(f.workspace,'sample.wav'));assert.equal(f.tools.active.size,0);
});
test('FourCC bytes must match exactly and format extension lengths cannot overrun',async t=>{
 const f=await fixture(t),magic=wav();magic[0]|=128;await f.put(magic);await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/RIFF WAV/);
 const ext=wav({extensible:true});ext.writeUInt16LE(200,36);await f.put(ext);await assert.rejects(f.tools.call({path:'sample.wav'},'chat'),/format extension/);
});
