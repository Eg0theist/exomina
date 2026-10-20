// Derive a reversible tonal alternative from the original local voice samples.
// No account storage, network, microphone, inference, speed or pitch change.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const source=fileURLToPath(new URL('../src/assets/voice-previews/',import.meta.url));
const target=process.argv[2]?path.resolve(process.argv[2]):fileURLToPath(new URL('../src/assets/voice-previews-clear/',import.meta.url));
assert.notEqual(path.resolve(source).toLowerCase(),path.resolve(target).toLowerCase(),'Original recordings must not be overwritten.');
const originals=JSON.parse(await readFile(path.join(source,'provenance.json'),'utf8'));
const voices=['arbor','breeze','cove','ember','juniper','maple','sol','spruce','vale'];
const profile=[
  {type:'peaking',frequency:300,q:0.8,gainDb:-2.5},
  {type:'peaking',frequency:3000,q:0.9,gainDb:2.5},
  {type:'highshelf',frequency:6500,slope:1,gainDb:1},
];
const ceilingDb=-1.2,maxGainDb=2;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function decode(bytes){
  assert.equal(bytes.toString('ascii',0,4),'RIFF');
  assert.equal(bytes.toString('ascii',8,12),'WAVE');
  let format,dataOffset,dataLength;
  for(let offset=12;offset+8<=bytes.length;){
    const id=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4);
    assert.ok(offset+8+length<=bytes.length,'Truncated WAV chunk.');
    if(id==='fmt '){
      assert.ok(length>=16);
      format={format:bytes.readUInt16LE(offset+8),channels:bytes.readUInt16LE(offset+10),sampleRate:bytes.readUInt32LE(offset+12),bits:bytes.readUInt16LE(offset+22)};
    }
    if(id==='data'){dataOffset=offset+8;dataLength=length;}
    offset+=8+length+(length%2);
  }
  assert.deepEqual(format,{format:1,channels:1,sampleRate:48000,bits:16},'Expected original mono PCM16/48kHz.');
  assert.ok(dataOffset!==undefined&&dataLength>0&&dataLength%2===0);
  const samples=new Float64Array(dataLength/2);
  for(let index=0;index<samples.length;index++)samples[index]=bytes.readInt16LE(dataOffset+index*2)/32768;
  return {format,dataOffset,samples};
}

function coefficients(filter,sampleRate){
  const omega=2*Math.PI*filter.frequency/sampleRate,cos=Math.cos(omega),sin=Math.sin(omega),a=Math.pow(10,filter.gainDb/40);
  let b0,b1,b2,a0,a1,a2;
  if(filter.type==='peaking'){
    const alpha=sin/(2*filter.q);
    b0=1+alpha*a;b1=-2*cos;b2=1-alpha*a;
    a0=1+alpha/a;a1=-2*cos;a2=1-alpha/a;
  }else{
    // RBJ high shelf S=1; unlike peaking, its slope is not a Q parameter.
    const alpha=sin/2*Math.sqrt((a+1/a)*(1/filter.slope-1)+2),beta=2*Math.sqrt(a)*alpha;
    b0=a*((a+1)+(a-1)*cos+beta);
    b1=-2*a*((a-1)+(a+1)*cos);
    b2=a*((a+1)+(a-1)*cos-beta);
    a0=(a+1)-(a-1)*cos+beta;
    a1=2*((a-1)-(a+1)*cos);
    a2=(a+1)-(a-1)*cos-beta;
  }
  return {b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:a1/a0,a2:a2/a0};
}

function filterSamples(samples,coefficients){
  const result=new Float64Array(samples.length);
  let x1=0,x2=0,y1=0,y2=0;
  for(let index=0;index<samples.length;index++){
    const x=samples[index],y=coefficients.b0*x+coefficients.b1*x1+coefficients.b2*x2-coefficients.a1*y1-coefficients.a2*y2;
    result[index]=y;x2=x1;x1=x;y2=y1;y1=y;
  }
  return result;
}

function metrics(samples){
  let energy=0,peak=0,clippedSamples=0;
  for(const sample of samples){
    assert.ok(Number.isFinite(sample),'Nonfinite filtered sample.');
    energy+=sample*sample;peak=Math.max(peak,Math.abs(sample));clippedSamples+=Math.abs(sample)>=1;
  }
  const rms=Math.sqrt(energy/samples.length);
  assert.ok(rms>0);
  return {rms,rmsDb:20*Math.log10(rms),peak,peakDb:20*Math.log10(peak),clippedSamples};
}

await mkdir(target,{recursive:true});
const provenance={
  source:'Derived from unchanged local ChatGPT voice preview recordings',
  originalSource:originals.source,
  preparation:'scripts/prepare-clear-voice-previews.mjs',
  processing:'Standard RBJ biquads in Float64, linear gain, one final PCM16 quantization. No compression, limiting, time stretch or pitch change.',
  profile,
  normalization:{aim:'Match original RMS; RMS is not a subjective loudness guarantee.',maxGainDb,samplePeakCeilingDb:ceilingDb},
  limitation:'A gentle tone adjustment. It does not reconstruct missing articulation or create a higher-quality voice recording.',
  clips:{},
};
for(const voice of voices){
  const original=await readFile(path.join(source,voice+'.wav')),originalSha256=hash(original);
  assert.equal(originalSha256,originals.clips[voice]?.sha256,'Original source hash changed: '+voice);
  const {format,dataOffset,samples}=decode(original),before=metrics(samples);
  let filtered=samples;
  for(const filter of profile)filtered=filterSamples(filtered,coefficients(filter,format.sampleRate));
  const unscaled=metrics(filtered),ceiling=Math.pow(10,ceilingDb/20);
  const gainDb=Math.min(maxGainDb,before.rmsDb-unscaled.rmsDb,20*Math.log10(ceiling/unscaled.peak)),gain=Math.pow(10,gainDb/20);
  const derived=Buffer.from(original);
  for(let index=0;index<filtered.length;index++){
    const sample=filtered[index]*gain;
    assert.ok(Math.abs(sample)<=ceiling+1e-10,'Filtered sample exceeds ceiling.');
    derived.writeInt16LE(Math.round(sample*32768),dataOffset+index*2);
  }
  const decoded=decode(derived),after=metrics(decoded.samples);
  assert.equal(decoded.samples.length,samples.length);
  assert.equal(after.clippedSamples,0);
  // Final PCM16 rounding can exceed the Float64 ceiling by half one sample step.
  assert.ok(after.peak<=ceiling+0.5/32768);
  const filename=voice+'-clear.wav';
  await writeFile(path.join(target,filename),derived);
  provenance.clips[voice]={filename,originalFilename:voice+'.wav',originalSourceAsset:originals.clips[voice].sourceAsset,originalSha256,sha256:hash(derived),bytes:derived.length,sampleRate:format.sampleRate,channels:format.channels,bits:format.bits,samples:samples.length,duration:samples.length/format.sampleRate,gainDb,before,after,rmsDifferenceDb:after.rmsDb-before.rmsDb};
}
await writeFile(path.join(target,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({target,voices,profile,samplePeakCeilingDb:ceilingDb,clips:Object.entries(provenance.clips).map(([voice,clip])=>({voice,sha256:clip.sha256,gainDb:clip.gainDb,peakDb:clip.after.peakDb,rmsDifferenceDb:clip.rmsDifferenceDb}))},null,2));
