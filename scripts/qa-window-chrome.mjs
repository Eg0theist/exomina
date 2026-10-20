// Real Electron title-bar APIs and renderer; temporary synthetic profile, no live account or app stores.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-window-chrome-'));
const preload=path.join(output,'preload.cjs'),entry=path.join(output,'fixture.cjs');
const server=await createServer({server:{port:5197},logLevel:'error'});await server.listen();
const url=`http://localhost:${server.config.server.port}/preview.html`;
await writeFile(preload,"const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('__exominaWindowQa',{invoke:(method,payload)=>ipcRenderer.invoke('qa-window',method,payload),onEvent:callback=>{ipcRenderer.on('qa-window-event',(_event,value)=>callback(value));}});");
await writeFile(entry,`const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',process.env.QA_PROFILE);app.whenReady().then(async()=>{
 const chrome=await import(${JSON.stringify(pathToFileURL(path.join(root,'desktop/window-chrome.mjs')).href)}),themes=await import(${JSON.stringify(pathToFileURL(path.join(root,'desktop/themes.mjs')).href)});
 let appearance=themes.normalizeAppearance({}),theme=themes.resolveTheme(appearance),options=chrome.windowChromeOptions({borderless:true,ground:theme.colors.ground,ink:theme.colors.ink});
 const win=new BrowserWindow({width:1360,height:900,show:false,backgroundColor:theme.colors.ground,...options,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 globalThis.qaWindow={options,theme,win};const state=()=>({...chrome.windowChromeState(win,{borderless:true}),theme:globalThis.qaWindow.theme.id});
 ipcMain.handle('qa-window',(_event,method,payload)=>{if(method==='state')return state();if(method==='action'){chrome.windowChromeCommand(win,payload.action);return state();}if(method==='theme'){appearance=themes.normalizeAppearance(payload);theme=themes.resolveTheme(appearance);chrome.applyWindowChromeTheme(win,{borderless:true,ground:theme.colors.ground,ink:appearance.textColor||theme.colors.ink});globalThis.qaWindow.theme=theme;return state();}throw Error('Unknown fixture action.');});
 for(const name of ['maximize','unmaximize','enter-full-screen','leave-full-screen'])win.on(name,()=>win.webContents.send('qa-window-event',{type:'window.changed',window:state()}));
 win.loadURL(${JSON.stringify(url)});
});app.on('window-all-closed',()=>app.quit());`);
const env={...process.env,QA_PROFILE:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const report={scope:'Real hidden Electron title-bar APIs, synthetic renderer/profile, no accounts/model calls',checks:{},errors:[]};let app;
try{
 app=await electron.launch({args:[entry],env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.getByRole('banner',{name:'Exomina window'}).waitFor();
 // Hidden windows can freeze CSS transition frames; this check concerns their settled theme.
 await page.addStyleTag({content:'.window-header{transition:none!important}'});
 const geometry=await page.evaluate(()=>{const header=document.querySelector('.window-header'),shell=document.querySelector('.app-shell'),overlay=navigator.windowControlsOverlay;const h=header.getBoundingClientRect(),s=shell.getBoundingClientRect(),r=overlay?.getTitlebarAreaRect();return{height:h.height,shellTop:s.top,drag:getComputedStyle(header).getPropertyValue('app-region'),overlayVisible:overlay?.visible,overlay:r&&{x:r.x,y:r.y,width:r.width,height:r.height},overflow:document.documentElement.scrollHeight>innerHeight,viewport:innerHeight,elements:['html','body','#root','.app-frame','.app-shell','.main-shell','.sidebar'].map(selector=>{const el=document.querySelector(selector),style=getComputedStyle(el);return{selector,height:el.getBoundingClientRect().height,scroll:el.scrollHeight,client:el.clientHeight,cssHeight:style.height,minHeight:style.minHeight,overflow:style.overflow}})};});
 report.checks.integratedHeaderAndNativeControls=geometry;assert.equal(geometry.height,40);assert.equal(geometry.shellTop,40);assert.equal(geometry.overflow,false);assert.equal(geometry.overlayVisible,true);assert.equal(geometry.overlay.height,40);assert.equal(geometry.drag,'drag');
 await page.keyboard.press('Control+,');await page.getByRole('navigation',{name:'Settings categories'}).getByRole('button',{name:/Appearance & audio/}).click();await page.locator('#settings-appearance').scrollIntoViewIfNeeded();
 const toggle=page.getByRole('switch',{name:'Borderless window',exact:true});await toggle.click();
 await page.getByText('This window style will apply when Exomina next starts.',{exact:true}).waitFor();assert.equal(await page.locator('.window-header').count(),1);
 assert.equal((await page.evaluate(()=>window.studio.invoke('bootstrap'))).settings.appearance.borderless,false);
 await toggle.click();assert.equal((await page.evaluate(()=>window.studio.invoke('bootstrap'))).settings.appearance.borderless,true);
 await page.getByRole('radio',{name:/^Paper/}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='paper'&&!document.documentElement.classList.contains('theme-switching'));
 const deadline=Date.now()+10000;while((await page.evaluate(()=>window.__exominaWindowQa.invoke('state'))).theme!=='paper'){if(Date.now()>deadline)throw Error('Native overlay theme did not update.');await new Promise(resolve=>setTimeout(resolve,50));}
 const theme=await app.evaluate(()=>globalThis.qaWindow.theme);
 const header=await page.locator('.window-header').evaluate(el=>({background:getComputedStyle(el).backgroundColor,text:getComputedStyle(el).color}));
 const expected=await page.evaluate(colors=>{const el=document.createElement('div');el.style.backgroundColor=colors.ground;el.style.color=document.querySelector('.window-header').classList.contains('is-unfocused')?'color-mix(in oklab, var(--t-text) 62%, var(--t-ground))':colors.ink;document.body.append(el);const style=getComputedStyle(el),values={background:style.backgroundColor,text:style.color};el.remove();return values;},theme.colors);
 report.checks.themeDiagnostic={native:theme,header,expected,renderer:await page.evaluate(()=>({dataset:{...document.documentElement.dataset},inline:document.documentElement.getAttribute('style'),rootGround:getComputedStyle(document.documentElement).getPropertyValue('--t-ground'),headerGround:getComputedStyle(document.querySelector('.window-header')).getPropertyValue('--t-ground'),rootText:getComputedStyle(document.documentElement).getPropertyValue('--t-text'),headerText:getComputedStyle(document.querySelector('.window-header')).getPropertyValue('--t-text')}))};
 assert.deepEqual(header,expected);report.checks.themeAndNativeOverlayUpdate=true;report.checks.styleTogglePreservesCurrentWindowAndExplainsRestart=true;
 await page.screenshot({path:path.join(output,'paper-header.png')});
 await page.getByRole('button',{name:'Exomina home',exact:true}).click();await page.screenshot({path:path.join(output,'home-header.png')});
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close();await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));}
