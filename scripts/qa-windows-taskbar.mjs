// Native Windows property store and shortcut APIs on a hidden synthetic window.
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WINDOWS_APP_ID, windowsTaskbarIcon } from '../desktop/windows-taskbar.mjs';

const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-windows-taskbar-'));
const exe=path.join(root,'release/win-unpacked/Exomina.exe'),icon=windowsTaskbarIcon(root);
const entry=path.join(output,'fixture.cjs'),link=path.join(output,'Exomina synthetic.lnk'),unrelated=path.join(output,'Unrelated.lnk');
await writeFile(entry,`const{app,BrowserWindow,shell}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output,'profile'))});app.setAppUserModelId(${JSON.stringify(WINDOWS_APP_ID)});app.whenReady().then(async()=>{
 const t=await import(${JSON.stringify(pathToFileURL(path.join(root,'desktop/windows-taskbar.mjs')).href)});
 const exe=${JSON.stringify(exe)},icon=${JSON.stringify(icon)},link=${JSON.stringify(link)},unrelated=${JSON.stringify(unrelated)};
 const win=new BrowserWindow({width:960,height:680,show:false,icon:${JSON.stringify(path.join(root,'build/icon.png'))}});win.setAppDetails(t.windowsTaskbarDetails(exe,icon));
 shell.writeShortcutLink(link,{target:exe,args:'--synthetic-test',cwd:${JSON.stringify(output)},description:'Synthetic shortcut; not a user pin',icon:exe,iconIndex:0});
 shell.writeShortcutLink(unrelated,{target:process.execPath,icon:process.execPath,iconIndex:0});
 const before=shell.readShortcutLink(link),first=t.repairWindowsShortcuts({shell,exe,icon,shortcutPaths:[link,unrelated]}),after=shell.readShortcutLink(link),second=t.repairWindowsShortcuts({shell,exe,icon,shortcutPaths:[link,unrelated]});
 globalThis.qaTaskbar={before,first,after,second,unrelated:shell.readShortcutLink(unrelated),handle:win.getNativeWindowHandle().readBigUInt64LE().toString()};await win.loadURL('data:text/html,<title>Synthetic Windows taskbar QA</title>');
});`);
const report={scope:'Native Electron taskbar metadata, Windows property store and synthetic shortcut repair. No actual user pins changed and no personal stores.',checks:{}};let app;
try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:[entry],env,timeout:30000});await app.firstWindow();
  const state=await app.evaluate(()=>globalThis.qaTaskbar);assert.deepEqual(state.first.updated,[link]);assert.deepEqual(state.first.failed,[]);assert.deepEqual(state.second,{updated:[],failed:[]});
  assert.equal(state.after.icon,icon);assert.equal(state.after.appUserModelId,WINDOWS_APP_ID);assert.equal(state.after.args,state.before.args);assert.equal(state.after.cwd,state.before.cwd);assert.notEqual(state.unrelated.appUserModelId,WINDOWS_APP_ID);report.checks.nativeShortcutRepair=state;
  const list=path.join(output,'shortcuts.json');await writeFile(list,JSON.stringify([link]));
  const {stdout}=await promisify(execFile)('powershell',['-NoProfile','-File',path.join(root,'scripts/qa-taskbar-icons.ps1'),'-Output',output,'-ExePath',exe,'-WindowHandle',state.handle,'-ShortcutList',list],{windowsHide:true,maxBuffer:1024*1024});
  const icons=JSON.parse(stdout),window=icons.find(item=>item.kind==='window'),shortcut=icons.find(item=>item.kind==='shell-shortcut');
  assert.equal(window.properties.appId,WINDOWS_APP_ID);assert.equal(window.properties.relaunchIcon,icon+',0');assert.equal(window.properties.relaunchCommand,`"${exe}"`);assert.equal(window.properties.displayName,'Exomina');
  assert.equal(shortcut.appId,WINDOWS_APP_ID);assert.equal(shortcut.icon,icon+',0');assert.ok(shortcut.palette.purple>100);assert.equal(window.palette.mint,0);assert.ok(window.palette.purple>100);report.checks.windowsPropertyStoreAndShellPixels=icons;report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
