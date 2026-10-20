// Copy preview recordings already present in the local Codex program installation.
// No account storage, network request, microphone or inference is involved.
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const source=path.resolve('../Workspace/codex-voice-inspection/installed-26.930.7945/webview/assets');
const output=path.resolve('src/assets/voice-previews');
const clips={arbor:'arbor.en.25550aca-970193c595b6.wav',breeze:'breeze.en.da5035ec-9a51e302b768.wav',cove:'cove.en.9d1a95cf-5c2cda1190c4.wav',ember:'ember.en.6c36df71-e217aa72f8ea.wav',juniper:'juniper.en.9ee0561e-1d9e22710c1f.wav',maple:'maple.en.7e717dcb-c0ccf13d5199.wav',sol:'sol.en.8a12cdaa-baed8f6dc0b1.wav',spruce:'spruce.en.b3269a2b-338508f43329.wav',vale:'vale.en.2eb74006-4fe383964169.wav'};
await mkdir(output,{recursive:true});
const provenance={source:'Locally installed OpenAI.Codex 26.930.7945.0 program assets',clips:{}};
for(const [voice,file] of Object.entries(clips)){
  const data=await readFile(path.join(source,file));
  if(data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE')throw Error('Invalid voice preview recording: '+voice);
  const sha256=createHash('sha256').update(data).digest('hex');
  if(!file.includes(sha256.slice(0,8)))throw Error('Codex preview content hash mismatch: '+voice);
  await copyFile(path.join(source,file),path.join(output,voice+'.wav'));
  provenance.clips[voice]={sourceAsset:file,bytes:data.length,sha256};
}
await writeFile(path.join(output,'provenance.json'),JSON.stringify(provenance,null,2));
console.log(JSON.stringify({output,voices:Object.keys(clips),bytes:Object.values(provenance.clips).reduce((sum,clip)=>sum+clip.bytes,0)},null,2));
