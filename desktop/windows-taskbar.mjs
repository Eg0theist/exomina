import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {DISTRIBUTION_PROFILE} from './distribution.mjs';

export const WINDOWS_APP_ID=DISTRIBUTION_PROFILE==='beta'?'local.exomina.beta.desktop':'local.exomina.desktop';
const equalPath=(a,b)=>!!a&&!!b&&path.win32.resolve(a).toLowerCase()===path.win32.resolve(b).toLowerCase();

/** A content-specific, unpacked ICO gives Explorer a fresh icon identity on colour changes. */
export function windowsTaskbarIcon(root,runtimeRoot=root){
  const manifest=JSON.parse(readFileSync(path.join(root,'build/taskbar-icon.json'),'utf8'));
  if(!/^icon-[a-f0-9]{16}\.ico$/.test(manifest.file)||!/^[a-f0-9]{64}$/.test(manifest.sha256)||manifest.file!==`icon-${manifest.sha256.slice(0,16)}.ico`)throw Error('Invalid Windows taskbar icon manifest.');
  const icon=path.join(runtimeRoot,'build/shell-icons',manifest.file);
  if(createHash('sha256').update(readFileSync(icon)).digest('hex')!==manifest.sha256)throw Error('Windows taskbar icon failed its integrity check.');
  return icon;
}

export function windowsTaskbarDetails(exe,icon,appId=WINDOWS_APP_ID){
  return {appId,appIconPath:icon,appIconIndex:0,relaunchCommand:`"${exe}"`,relaunchDisplayName:'Exomina'};
}

/** Update only shortcuts already pointing at this installed executable. */
export function repairWindowsShortcuts({shell,exe,icon,appData,desktop,shortcutPaths}){
  const result={updated:[],failed:[]};
  let paths=shortcutPaths;
  if(!paths){
    paths=[];
    if(appData){
      paths.push(path.join(appData,'Microsoft/Windows/Start Menu/Programs/Exomina.lnk'));
      const pinned=path.join(appData,'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar');
      try{paths.push(...readdirSync(pinned).filter(file=>/\.lnk$/i.test(file)).map(file=>path.join(pinned,file)));}catch{}
    }
    if(desktop)paths.push(path.join(desktop,'Exomina.lnk'));
    paths=paths.filter(file=>existsSync(file));
  }
  for(const file of new Set(paths)){
    try{
      const previous=shell.readShortcutLink(file);
      if(!equalPath(previous.target,exe))continue;
      if(equalPath(previous.icon,icon)&&previous.iconIndex===0&&previous.appUserModelId===WINDOWS_APP_ID)continue;
      if(!shell.writeShortcutLink(file,'update',{...previous,icon,iconIndex:0,appUserModelId:WINDOWS_APP_ID}))throw Error('Windows did not update the shortcut.');
      result.updated.push(file);
    }catch(error){result.failed.push({path:file,message:error.message});}
  }
  return result;
}
