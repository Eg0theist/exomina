// Real renderer and mouse/keyboard input, synthetic chats only; window stays hidden.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import path from 'node:path';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {extractFile} from '@electron/asar';
import {createHash} from 'node:crypto';
const root=process.cwd(),output=path.resolve(process.argv[2]||'../Workspace/ghidra-sidebar-20261011/sidebar'),baseline=process.argv.includes('--baseline');
await mkdir(output,{recursive:true});
const packagedAsar=process.env.EXOMINA_QA_PACKAGED_ASAR,resources={},prefix='/__qa_packaged/';
const plugin=packagedAsar?{name:'qa-exact-packaged-sidebar',configureServer(server){server.middlewares.use((req,res,next)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;if(!pathname.startsWith(prefix))return next();const relative=pathname.slice(prefix.length);
 if(!relative||relative.split('/').some(part=>!part||part==='..'||part==='.')){res.statusCode=400;return res.end();}
 try{const bytes=extractFile(packagedAsar,path.join('dist',...relative.split('/')));resources['dist/'+relative]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(relative)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(relative==='index.html'?bytes.toString('utf8').replaceAll('./assets/',prefix+'assets/').replace('<head>','<head><script type="module" src="/preview/mock-studio.mjs"></script>'):bytes);}catch{res.statusCode=404;res.end('Packaged QA asset unavailable');}
});}}:null;
const server=await createServer({root,plugins:plugin?[plugin]:[],server:{port:0,hmr:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}${packagedAsar?prefix+'index.html':'/preview.html'}`,EXOMINA_DESIGN_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});
const report={passed:false,baseline,layouts:[],errors:[],scope:packagedAsar?'Exact packaged renderer in a hidden Electron window with synthetic chats; no app accounts or provider calls.':'Source renderer in a hidden Electron window with synthetic chats; no app accounts or provider calls.'};
if(packagedAsar){report.packagedAsar=path.resolve(packagedAsar);report.version=JSON.parse(extractFile(packagedAsar,'package.json').toString()).version;report.build=JSON.parse(await readFile(path.resolve(path.dirname(packagedAsar),'../exomina.build.json'),'utf8'));}
try{
 const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home'}).waitFor();
 await page.evaluate(()=>window.__exominaPreviewSetChats(Array.from({length:24},(_,i)=>({id:'recent-'+i,title:`Recent project ${String(i+1).padStart(2,'0')}`,provider:'codex',updatedAt:new Date(Date.now()-i*60000).toISOString(),messages:[],sessions:{}}))));
 await page.waitForFunction(()=>document.querySelectorAll('.chat-open').length>=24);
 for(const [width,height] of [[1360,900],[1360,720],[1024,768],[700,720]]){
  await page.setViewportSize({width,height});await page.screenshot({path:path.join(output,`${width}-${height}-viewport.png`)});if(width<860)await page.getByRole('button',{name:'Open navigation'}).click();await page.waitForTimeout(150);
  const layout=await page.evaluate(()=>{const list=document.querySelector('.chat-list-scroll'),r=list.getBoundingClientRect(),sidebar=document.querySelector('.sidebar').getBoundingClientRect();return {listHeight:r.height,visibleChats:[...list.querySelectorAll('.chat-open')].filter(el=>{const row=el.getBoundingClientRect();return row.top>=r.top&&row.bottom<=r.bottom;}).length,navHeight:document.querySelector('.nav-list').getBoundingClientRect().height,sidebarHeight:sidebar.height,overflow:document.querySelector('.sidebar').scrollHeight>sidebar.height+2};});
  report.layouts.push({width,height,...layout});await page.screenshot({path:path.join(output,`${width}-${height}.png`)});
  if(!baseline){assert.ok(layout.visibleChats>=(height>=900?11:5),'Recent chats must have useful visible space');assert.equal(layout.overflow,false,'Sidebar itself must not overflow');}
  if(width<860)await page.getByRole('button',{name:'Close navigation',exact:true}).click();
 }
 if(!baseline){
  await page.setViewportSize({width:1360,height:900});await page.screenshot({path:path.join(output,'actions-viewport.png')});
  for(const label of ['Memory','Tools','Connections','Projects & prompts']){const button=page.getByRole('button',{name:label,exact:true});await button.click();await assert.equal(await button.getAttribute('aria-current'),'page');}
  await page.locator('.chat-open').first().click();await page.locator('.usage-summary').click();await page.getByRole('dialog',{name:'Subscription usage'}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'Subscription usage'}).count(),0);
  const search=page.getByRole('searchbox',{name:'Search chats'});await search.fill('Recent project 12');await page.locator('[data-chat-id="recent-11"] .chat-open').click();await search.fill('');
  await page.getByRole('button',{name:'More options for Recent project 12'}).click();await page.getByRole('menuitem',{name:'Pin',exact:true}).click();await page.getByText('PINNED',{exact:true}).waitFor();
  const pinned=page.getByRole('region',{name:'Pinned chats'}),beforePin=await pinned.boundingBox();assert.equal(await pinned.locator('[data-chat-id="recent-11"]').count(),1);
  await page.getByRole('region',{name:'Recent chats',exact:true}).evaluate(list=>list.scrollTop=list.scrollHeight);await page.waitForTimeout(150);
  const afterPin=await pinned.boundingBox();assert.ok(Math.abs(beforePin.y-afterPin.y)<1,'Pinned section must not move when recent chats scroll');assert.equal(await page.locator('.chat-list-scroll [data-chat-id="recent-11"]').count(),0,'Pinned chat appears only once');
  await pinned.locator('.chat-open').click();report.pinnedChatsStayVisible=true;await page.screenshot({path:path.join(output,'pinned-scroll.png')});
  await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('heading',{name:'App analysis',exact:true}).waitFor();await page.getByRole('tab',{name:/Ghidra project/}).waitFor();
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;throw error;}finally{if(packagedAsar)report.resources=resources;await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));await app.close();await server.close();}
console.log(JSON.stringify(report));
