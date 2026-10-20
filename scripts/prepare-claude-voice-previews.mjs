import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const source='C:/Program Files/WindowsApps/Claude_2.26454.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/audio/voice/selection';
const target=path.resolve('src/assets/claude-voice-previews');
await mkdir(target,{recursive:true});
const clips={};
for(const id of ['buttery','airy','mellow','glassy','rounded']){
  const filename=id+'.mp3',bytes=await readFile(path.join(source,filename));
  if(bytes.length<1000)throw Error('Invalid installed voice recording: '+id);
  await writeFile(path.join(target,filename),bytes);
  clips['claude:'+id]={originalFilename:filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
await writeFile(path.join(target,'provenance.json'),JSON.stringify({source:'Installed Claude desktop 2.26454.0.0 program voice samples',sourceDirectory:source,scope:'Program assets only; no account stores accessed',clips},null,2)+'\n');
console.log('Prepared '+Object.keys(clips).length+' local Claude desktop voice samples.');
