import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WINDOWS_APP_ID, windowsTaskbarIcon, windowsTaskbarDetails, repairWindowsShortcuts } from '../desktop/windows-taskbar.mjs';

test('taskbar icon uses unpacked content identity and rejects changed bytes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'exomina-taskbar-')),runtime=path.join(root,'runtime');
  const bytes=await readFile('build/icon.ico'),sha256=createHash('sha256').update(bytes).digest('hex'),file=`icon-${sha256.slice(0,16)}.ico`;
  await mkdir(path.join(root,'build'),{recursive:true});await mkdir(path.join(runtime,'build/shell-icons'),{recursive:true});
  const icon=path.join(runtime,'build/shell-icons',file);
  await writeFile(icon,bytes);await writeFile(path.join(root,'build/taskbar-icon.json'),JSON.stringify({file,sha256}));
  assert.equal(windowsTaskbarIcon(root,runtime),icon);
  await writeFile(icon,'damaged');assert.throws(()=>windowsTaskbarIcon(root,runtime),/integrity/);
  await writeFile(path.join(root,'build/taskbar-icon.json'),JSON.stringify({file:'../../outside.ico',sha256}));assert.throws(()=>windowsTaskbarIcon(root,runtime),/manifest/);
});

test('taskbar relaunch keeps the executable quoted and its identity matches shortcuts',()=>{
  const details=windowsTaskbarDetails('C:\\Program Files\\Exomina\\App\\Exomina.exe','C:\\App\\icon-abcd.ico');
  assert.equal(details.relaunchCommand,'"C:\\Program Files\\Exomina\\App\\Exomina.exe"');assert.equal(details.appId,WINDOWS_APP_ID);
  assert.equal(details.relaunchDisplayName,'Exomina');assert.equal(details.appIconIndex,0);
});

test('repair preserves shortcut launch arguments and changes only this install',()=>{
  const exe='C:\\Program Files\\Exomina\\App\\Exomina.exe',icon='C:\\App\\icon-purple.ico';
  const links=new Map([['pin.lnk',{target:exe.toUpperCase(),args:'--example',cwd:'C:\\work',description:'My Exomina',icon:exe,iconIndex:0}],['other.lnk',{target:'C:\\Other\\Exomina.exe'}]]);
  const calls=[],shell={readShortcutLink:file=>links.get(file),writeShortcutLink:(file,operation,details)=>{calls.push({file,operation,details});links.set(file,details);return true;}};
  assert.deepEqual(repairWindowsShortcuts({shell,exe,icon,shortcutPaths:[...links.keys()]}),{updated:['pin.lnk'],failed:[]});
  assert.deepEqual(calls[0].details,{target:exe.toUpperCase(),args:'--example',cwd:'C:\\work',description:'My Exomina',icon,iconIndex:0,appUserModelId:WINDOWS_APP_ID});
  assert.deepEqual(repairWindowsShortcuts({shell,exe,icon,shortcutPaths:[...links.keys()]}),{updated:[],failed:[]});assert.equal(calls.length,1);
});

test('one unavailable shortcut does not prevent repair of the remaining links',()=>{
  const exe='C:\\Exomina.exe',shell={readShortcutLink:file=>{if(file==='bad.lnk')throw Error('locked');return {target:exe};},writeShortcutLink:()=>true};
  const result=repairWindowsShortcuts({shell,exe,icon:'C:\\purple.ico',shortcutPaths:['bad.lnk','good.lnk']});assert.deepEqual(result.updated,['good.lnk']);assert.equal(result.failed[0].message,'locked');
});
