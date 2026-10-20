// Synthetic long-chat responsiveness, measured in the real hidden Electron renderer.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {extractFile} from '@electron/asar';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve(process.argv[2]||'../Workspace/ghidra-sidebar-followups-20261011/performance'),packagedAsar=process.env.EXOMINA_QA_PACKAGED_ASAR,builtDist=process.env.EXOMINA_QA_DIST;
assert.ok(!(packagedAsar&&builtDist),'Choose a packaged archive or a built dist folder.');
await mkdir(output,{recursive:true});
const prefix='/__qa_packaged/',resources={};
const production=!!(packagedAsar||builtDist);
const plugin=production?{name:'qa-exact-renderer',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const relative=new URL(req.url,'http://localhost').pathname.slice(prefix.length);if(!req.url.startsWith(prefix))return next();
 if(!relative||relative.split('/').some(part=>!part||part==='..'||part==='.')){res.statusCode=400;return res.end();}
 try{const bytes=packagedAsar?extractFile(packagedAsar,path.join('dist',relative)):await readFile(path.join(builtDist,relative));resources['dist/'+relative]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(relative)]||'application/octet-stream');res.end(relative==='index.html'?bytes.toString('utf8').replaceAll('./assets/',prefix+'assets/').replace('<head>','<head><script type="module" src="/preview/mock-studio.mjs"></script>'):bytes);}catch{res.statusCode=404;res.end();}
 });}}:null;
const server=await createServer({root,plugins:plugin?[plugin]:[],server:{port:0,hmr:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}${production?prefix+'index.html':'/preview.html'}`,EXOMINA_DESIGN_QA_DIR:output};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000}),report={passed:false,scope:'Synthetic data, hidden Electron, no provider calls or app accounts',measurements:[],errors:[],resources};
if(packagedAsar){report.version=JSON.parse(extractFile(packagedAsar,'package.json')).version;report.build=JSON.parse(await readFile(path.resolve(path.dirname(packagedAsar),'../exomina.build.json'),'utf8'));}
try{
 const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message));await page.getByRole('button',{name:'Exomina home'}).waitFor();
 await page.evaluate(()=>{
  const body=Array.from({length:12},(_,i)=>`### Observation ${i+1}\n\nSome **bold** text and [a source](https://example.com/${i}) with a concrete result. This paragraph gives enough content to exercise long conversations.\n\n- Evidence collected\n- A result was verified\n\n`).join('');
  const messages=Array.from({length:140},(_,i)=>({id:'history-'+i,role:i%2?'assistant':'user',provider:'codex',content:body,finishedAt:new Date().toISOString(),...(i%2?{activity:[{id:'note-'+i,kind:'note',text:'The previous work completed.\n\n'+body.slice(0,500),status:'done'}]}:{})}));
  messages.push({id:'live',role:'assistant',provider:'codex',content:'',activity:[],startedAt:new Date().toISOString()});
  window.__exominaPreviewSetChats([{id:'perf-chat',title:'Performance fixture',provider:'codex',updatedAt:new Date().toISOString(),messages,sessions:{}}]);
 });
 await page.locator('[data-chat-id="perf-chat"] .chat-open').click();await page.locator('[data-message-index="140"]').waitFor();await page.screenshot({path:path.join(output,'viewport.png')});
 const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
 const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
 async function measure(name,stream){
  await page.waitForTimeout(350);const before=await metrics();
  if(stream){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
  const sample=await page.evaluate(async({stream})=>{
   const start=performance.now(),ticks=[],tasks=[],frames=[],mutations=[];let emitted=0,lastTick=start,lastFrame=start,expected='';
   const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(entry=>entry.duration)));observer.observe({type:'longtask'});
   const ticker=setInterval(()=>{const now=performance.now();ticks.push(now-lastTick);lastTick=now;},50);
   let stopped=false;const frame=now=>{frames.push(now-lastFrame);lastFrame=now;if(!stopped)requestAnimationFrame(frame);};requestAnimationFrame(frame);
   const live=document.querySelector('[data-message-index="140"]'),mutation=new MutationObserver(()=>mutations.push(performance.now()));mutation.observe(live,{subtree:true,childList:true,characterData:true});expected=live.querySelector('.message-content')?.textContent||'';
   let streamTimer;
   if(stream){window.__exominaPreviewSetRun('perf-chat',new Date().toISOString());window.__exominaPreviewEmit({type:'chat.started',conversationId:'perf-chat',messageId:'live',provider:'codex',startedAt:new Date().toISOString()});
    streamTimer=setInterval(()=>{const text=` update-${++emitted}`;expected+=text;window.__exominaPreviewEmit({type:'chat.delta',conversationId:'perf-chat',text});window.__exominaPreviewEmit({type:'chat.activity',conversationId:'perf-chat',step:{id:'progress',kind:'tool',status:'running',title:'Synthetic work',name:'fixture'},append:'.'});},20);
   }
   await new Promise(resolve=>setTimeout(resolve,4500));clearInterval(streamTimer);const end=performance.now();
   await new Promise(resolve=>setTimeout(resolve,150));clearInterval(ticker);stopped=true;observer.disconnect();mutation.disconnect();
   const sorted=[...ticks].sort((a,b)=>a-b),p95=sorted[Math.floor(sorted.length*.95)]||0;
   return {durationMs:end-start,emitted,expected,observed:live.querySelector('.message-content')?.textContent||'',timerP95Ms:p95,timerMaxMs:Math.max(0,...ticks),longTasks:tasks.length,longTaskMs:tasks.reduce((a,b)=>a+b,0),longTaskMaxMs:Math.max(0,...tasks),frames:frames.length,liveMutations:mutations.length};
  },{stream});
  const after=await metrics();for(const key of ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'])sample[key+'Ms']=(after[key]-before[key])*1000;
  if(stream){const {profile}=await cdp.send('Profiler.stop');await writeFile(path.join(output,'cpu-profile.json'),JSON.stringify(profile),'utf8');}
  if(stream)assert.equal(sample.observed.trim(),sample.expected.trim(),'Every streamed character must be retained');delete sample.expected;delete sample.observed;
  report.measurements.push({name,...sample});
 }
 await measure('idle-long-chat',false);
 const repeats=Math.max(1,Math.min(5,Number(process.env.EXOMINA_QA_SAMPLES)||1)),input=page.getByRole('textbox',{name:'Message',exact:true});
 for(let round=0;round<repeats;round++){
  const active=measure('active-long-chat',true);await page.waitForTimeout(700);
  const start=performance.now();await input.fill('Still responsive '+round);assert.equal(await input.inputValue(),'Still responsive '+round);const typingMs=performance.now()-start;
  await active;report.measurements.at(-1).composerFillMs=typingMs;
 }
 // Navigation remains usable while a reply is running.
 await page.getByRole('button',{name:'Projects & prompts',exact:true}).click();await page.locator('[data-chat-id="perf-chat"] .chat-open').click();
 const beforeRefreshes=await page.evaluate(()=>window.__exominaPreviewCalls.filter(call=>call.method==='bootstrap').length);
 await page.evaluate(()=>{for(let n=0;n<40;n++)window.__exominaPreviewEmit({type:'state.changed'});});await page.waitForTimeout(1000);
 report.refreshBurst={events:40,reads:await page.evaluate(()=>window.__exominaPreviewCalls.filter(call=>call.method==='bootstrap').length)-beforeRefreshes};
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=error.stack;throw error;}finally{await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));await app.close();await server.close();}
console.log(JSON.stringify(report));
