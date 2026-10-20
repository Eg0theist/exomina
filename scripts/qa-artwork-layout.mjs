// Real renderer and artwork in a hidden synthetic preview; no personal profile or accounts.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { THEMES } from '../desktop/themes.mjs';

const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-artwork-layout-'));
const server=await createServer({root,server:{port:5193,strictPort:false},logLevel:'error'});
await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'renderer-profile')};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const report={output,scope:'Hidden synthetic renderer and real artwork, including the supplied screen dimensions at 175% scaling; no personal data or model inference.',errors:[],layouts:[]};
try{
 app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(error.message));
 await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await page.locator('[data-chat-id="c1"] .chat-open').click();
 const cdp=await page.context().newCDPSession(page),sizes=[[900,720],[1360,900],[1920,1080],[2560,1440],[3440,1440],[5120,1440]];
 const setSize=async(width,height,scale=1)=>{
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:false});
  await page.waitForFunction(({width,height})=>{
   const root=document.documentElement,shell=document.querySelector('.main-shell');
   if(!shell||innerWidth!==width||innerHeight!==height||Math.abs(document.querySelector('.app-frame').getBoundingClientRect().bottom-height)>1)return false;
   if(root.dataset.artworkFit!=='panorama')return true;
   const rect=shell.getBoundingClientRect(),w=parseFloat(root.style.getPropertyValue('--artwork-width')),h=parseFloat(root.style.getPropertyValue('--artwork-height')),aspect=Number(root.style.getPropertyValue('--theme-art-aspect'));
   return Math.abs(w-Math.max(rect.width,rect.height*32/9))<.01&&Math.abs(w/h-aspect)<.0001;
  },{width,height});
 };
 const inspect=()=>page.evaluate(()=>{
  const shell=document.querySelector('.main-shell'),rect=shell.getBoundingClientRect(),root=document.documentElement,before=getComputedStyle(shell,'::before'),after=getComputedStyle(shell,'::after');
  const width=parseFloat(root.style.getPropertyValue('--artwork-width')),height=parseFloat(root.style.getPropertyValue('--artwork-height')),positions=root.style.getPropertyValue('--artwork-position').match(/[\d.]+/g)?.map(Number)||[];
  const x=(width-rect.width)*(positions[0]||0)/100,y=(height-rect.height)*(positions[1]||0)/100;
  // Bounds of the painted black disc, measured on the actual panorama.
  const subject={left:.714*width-x,right:.799*width-x,top:.148*height-y,bottom:.411*height-y};
  return{theme:root.dataset.theme,viewport:[innerWidth,innerHeight],scale:devicePixelRatio,frame:[rect.width,rect.height],header:document.querySelector('.topbar').getBoundingClientRect().height,aspect:Number(root.style.getPropertyValue('--theme-art-aspect')),fit:root.dataset.artworkFit,size:before.backgroundSize,repeat:before.backgroundRepeat,position:before.backgroundPosition,mask:before.maskImage,filter:before.filter,fill:after.display,fillFilter:after.filter,edges:[!!root.style.getPropertyValue('--theme-art-left'),!!root.style.getPropertyValue('--theme-art-right')],fillDuplicatesSubject:after.backgroundImage.includes('/theme-art/'),width,height,subject,horizon:.54*height-y,overflow:root.scrollWidth>innerWidth};
 });
 const check=layout=>{
  assert.equal(layout.overflow,false);assert.deepEqual(layout.edges,[false,false],'No stretched strips from the painting');assert.equal(layout.mask,'none','No central image faded into synthetic side bands');assert.equal(layout.fillDuplicatesSubject,false);
  if(layout.theme==='erebus-flame'){
   assert.equal(layout.fit,'panorama');assert.match(layout.size,/^100% 100%, [\d.]+px [\d.]+px$/);assert.ok(layout.repeat.split(',').every(value=>value.trim()==='no-repeat'));
   assert.ok(layout.width>=layout.frame[0]-.01&&layout.height>=layout.frame[1]-.01,'Real artwork covers the canvas');
   assert.ok(layout.subject.left>=0&&layout.subject.right<=layout.frame[0]&&layout.subject.top>layout.header+5&&layout.subject.bottom<layout.frame[1],'The whole black sun stays below the toolbar and inside the canvas');
   assert.ok(Math.abs((layout.horizon-layout.header)/(layout.frame[1]-layout.header)-.53)<.001,'The horizon stays at the same height below the toolbar');
  }else{assert.equal(layout.fit,'standard');assert.match(layout.size,/^cover(?:, cover)*$/,'Other themes retain their original composition');}
  if(['neon-leather','nocturne'].includes(layout.theme))assert.ok(layout.filter.includes('blur(8px)'),'Soft themes keep their finish');
  if(layout.theme==='neo-babylon')assert.equal(layout.size.split(',').length,3,'All theme gradients remain present');
 };
 for(const id of ['erebus-flame','neo-babylon','neon-leather','nocturne','dusk','deep-sea','ink-wash','dune','sakura','aurora']){
  const theme=THEMES.find(theme=>theme.id===id);await page.evaluate(theme=>window.studio.invoke('settings.save',{appearance:{theme,motion:'reduced'}}),id);await page.waitForFunction(id=>document.documentElement.dataset.theme===id,id);
  await page.evaluate(async artwork=>{const img=new Image();img.src=new URL(artwork,document.baseURI).href;await img.decode();},theme.artwork);
  for(const[width,height]of ['erebus-flame','neo-babylon','neon-leather','dusk'].includes(id)?sizes:[[1920,1080],[5120,1440]]){
   await setSize(width,height);const layout=await inspect();check(layout);report.layouts.push(layout);
   if(id==='erebus-flame'||(id==='neon-leather'&&width===3440))await page.screenshot({path:path.join(output,`${id}-${width}.png`)});
  }
 }
 await page.evaluate(()=>window.studio.invoke('settings.save',{appearance:{theme:'erebus-flame',motion:'reduced'}}));
 report.scaledScreens=[];
 for(const physicalWidth of[3440,5120]){
  await setSize(Math.round(physicalWidth/1.75),Math.round(1440/1.75),1.75);const layout=await inspect();check(layout);report.scaledScreens.push(layout);await page.screenshot({path:path.join(output,`erebus-${physicalWidth}-175-percent.png`)});
 }
 assert.ok(Math.abs(report.scaledScreens[0].height-report.scaledScreens[1].height)<.01,'Changing screen width does not resize the sun');
 const boundary=[];for(const width of[3343,3345]){await setSize(width,1440);const layout=await inspect();check(layout);boundary.push(layout.height);}
 assert.ok(Math.abs(boundary[1]-boundary[0])<.01,'The former breakpoint does not change the subject scale');report.breakpointHeights=boundary;
 await setSize(3440,1440);await page.getByRole('button',{name:'Browser',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.browser-panel')?.getBoundingClientRect().width>0);await setSize(3440,1440);
 report.browserSplit=await inspect();check(report.browserSplit);assert.ok(Math.abs(report.browserSplit.height-boundary[0])<.01,'Opening the browser keeps the sun scale');await page.screenshot({path:path.join(output,'erebus-browser-split.png')});await page.getByRole('button',{name:'Close embedded browser',exact:true}).click();
 await page.evaluate(()=>window.studio.invoke('settings.save',{appearance:{theme:'paper',motion:'reduced'}}));await page.waitForFunction(()=>document.documentElement.dataset.theme==='paper');assert.equal(await page.getAttribute('html','data-artwork'),null);assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--artwork-size')),'');assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
finally{await app?.close().catch(()=>{});await server.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,passed:report.passed,layouts:report.layouts.length,scaledScreens:report.scaledScreens,breakpointHeights:report.breakpointHeights,error:report.error,errors:report.errors},null,2));}
