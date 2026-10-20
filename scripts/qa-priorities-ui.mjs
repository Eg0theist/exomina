// Exact production renderer, synthetic host responses and a separate hidden profile.
import {_electron as electron} from 'playwright';
import {createServer} from 'vite';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve(process.argv[2]||'../Workspace/priorities-20261020/ui'),prefix='/__qa_production/';await mkdir(output,{recursive:true});
const server=await createServer({root,logLevel:'error',server:{port:0,hmr:false},plugins:[{name:'production-fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(!req.url.startsWith(prefix))return next();const relative=new URL(req.url,'http://local').pathname.slice(prefix.length);if(!relative||relative.includes('..')){res.statusCode=400;return res.end();}try{const bytes=await readFile(path.join(root,'dist',relative));res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(relative)]||'application/octet-stream');res.end(relative==='index.html'?bytes.toString('utf8').replaceAll('./assets/',prefix+'assets/').replace('<head>','<head><script type="module" src="/preview/mock-studio.mjs"></script>'):bytes);}catch{res.statusCode=404;res.end();}});}}]});await server.listen();const env={...process.env,EXOMINA_DESIGN_QA_DIR:output,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}${prefix}index.html`};delete env.ELECTRON_RUN_AS_NODE;const app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000}),report={scope:'Compiled production renderer with isolated synthetic responses. No installed app, credentials, microphone or payments used.',checks:[],errors:[]};
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();
 await page.evaluate(()=>{
  const discord={telegram:{enabled:false,state:'off'},discord:{enabled:true,state:'connected',taskExecution:true,paired:[{id:'fixture',name:'Fixture owner',pairedAt:new Date().toISOString(),taskMode:'ask'}]}};
  window.__exominaFeatureQa=async(method,payload)=>{
   if(method==='messaging.permissions'){discord.discord.paired[0].taskMode=payload.mode;return structuredClone(discord);}
   if(method==='remote.status'||method==='remote.reconnect'||method==='remote.refresh')return {configured:true,enabled:true,connected:method==='remote.reconnect',base:'https://relay.example.com',error:method==='remote.reconnect'?'':'Relay fixture is offline.',errorCode:'dns',retryAt:new Date(Date.now()+30000).toISOString(),phones:[],pending:[]};
   if(method==='data.backup')return {path:'C:/Synthetic/backup',counts:{chats:2,messages:5,attachments:1},warnings:[]};
   if(method==='data.backupRestore')return {path:'C:/Synthetic/restored',counts:{chats:2,attachments:1},verifiedFiles:8};
   if(method==='memory.quality')return {notes:[{id:'new',text:'Catchup reserve 30%.',date:'2026-10-20',sourceChatIds:[],evidence:{confirmedAt:null}}],conflicts:[],scanned:1,notice:'Synthetic review data'};
   if(method==='memory.evidence')return {recorded:true};
   if(method==='character.export')return {path:'C:/Synthetic/character.json'};
   if(method==='character.import')return {applied:true};
  };
  window.__exominaDiscordFeatureFixture=discord;window.__exominaPreviewEmit({type:'messaging.status',status:discord});
 });
 await page.keyboard.press('Control+,');const search=page.getByLabel('Search settings',{exact:true});await search.waitFor();
 async function settings(query,id){await search.fill(query);await search.press('Enter');await page.locator('#settings-'+id).waitFor();}
 if(process.argv.includes('--visual-only')){
  await page.setViewportSize({width:900,height:750});await settings('Memory & privacy','memory');await page.getByRole('button',{name:'View saved memories',exact:true}).click();await page.getByText('Review memory changes and possible contradictions',{exact:true}).click();await page.getByLabel('Memory review topic').fill('reserve');await page.getByRole('button',{name:'Find related notes',exact:true}).click();await page.getByText('Catchup reserve 30%.',{exact:true}).waitFor();await page.locator('.memory-evidence').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('.memory-evidence').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));await page.screenshot({path:path.join(output,'memory-review.png')});report.checks.push('Styled memory review remains within a 900px window');
 }else{
 await settings('Messaging','messaging');await page.evaluate(()=>window.__exominaPreviewEmit({type:'messaging.status',status:window.__exominaDiscordFeatureFixture}));const access=page.getByLabel('Discord access for Fixture owner');await access.selectOption('full');assert.equal(await access.inputValue(),'full');report.checks.push('Discord access selector applies per-account Full access');
 await settings('Phone access','phone');await page.getByRole('button',{name:'Reconnect now',exact:true}).click();await page.getByText('Computer connected to your relay.',{exact:true}).waitFor();report.checks.push('Phone diagnostic state and explicit reconnect');
 await settings('Export & transfer','data');await page.getByRole('button',{name:'Back up library',exact:true}).click();await page.getByText(/Saved 2 chats and 1 attachments/).waitFor();await page.getByRole('button',{name:'Restore library',exact:true}).click();await page.getByText(/Open.*Open restored Exomina.ps1/).waitFor();report.checks.push('Library backup and separate restore controls/results');
 await settings('Personalisation','personalization');await page.getByText('Character profiles: personality, avatar and voice',{exact:true}).click();await page.getByRole('button',{name:'Export character profile',exact:true}).click();await page.getByText('Character profile saved.',{exact:true}).waitFor();report.checks.push('Character profile export through compiled UI');
 await settings('Memory & privacy','memory');await page.getByRole('button',{name:'View saved memories',exact:true}).click();await page.getByText('Review memory changes and possible contradictions',{exact:true}).click();await page.getByLabel('Memory review topic').fill('reserve');await page.getByRole('button',{name:'Find related notes',exact:true}).click();await page.getByText('Catchup reserve 30%.',{exact:true}).waitFor();await page.getByRole('button',{name:'Confirm this note',exact:true}).click();report.checks.push('Memory review search and confirmation');
 await page.screenshot({path:path.join(output,'memory-review.png')});
 }assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.failure=e.stack;process.exitCode=1;}finally{await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2),'utf8');await app.close();await server.close();}console.log(JSON.stringify(report));
