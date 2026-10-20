// Inspect installed Codex program assets only. Never read user profiles or account stores.
import {listPackage,extractFile} from '@electron/asar';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const archive='C:/Program Files/WindowsApps/OpenAI.Codex_26.930.7945.0_x64__2p2nqsd0c76g0/app/resources/app.asar';
const files=listPackage(archive).map(file=>file.replaceAll('\\','/').replace(/^\//,''));
const code=files.filter(file=>!file.startsWith('node_modules/')&&/\.(js|json|map)$/.test(file));
const audio=files.filter(file=>/\.(mp3|ogg|wav|opus|aac|m4a)$/.test(file));
const output=path.resolve('../Workspace/codex-voice-inspection/installed-26.930.7945');
const selected=[...code.filter(file=>file.startsWith('.vite/build/')||/voice|realtime/.test(file)||file==='package.json'),...audio];
if(process.argv.includes('--extract')) {
  for(const file of selected){const target=path.resolve(output,file);if(!target.startsWith(output+path.sep))throw Error('Unexpected archive path');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,extractFile(archive,path.normalize(file)));}
  await writeFile(path.join(output,'inspection-provenance.json'),JSON.stringify({archive,scope:'Installed program assets only; no profiles, account stores or credentials.',files:selected,audio},null,2));
}
console.log(JSON.stringify({archive,output,count:files.length,extracted:process.argv.includes('--extract')?selected.length:0,audio,voice:files.filter(file=>/voice|realtime/i.test(file)).slice(0,70)},null,2));
