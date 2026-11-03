import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {OutcomeMarks,OUTCOME_TOOL,processInfo} from '../desktop/outcome-marks.mjs';
import {hostAction,PermissionPolicy} from '../desktop/permissions.mjs';
import {describeTool} from '../desktop/describe.mjs';
import {LEAN_TOOLS} from '../desktop/routing.mjs';
import {FOLLOWUP_READ_TOOLS} from '../desktop/followup-tools.mjs';
import {workingInstructions} from '../desktop/context.mjs';

const json=(value,{status=200,headers={}}={})=>new Response(JSON.stringify(value),{status,headers});
function fixture(overrides={}){
 const chat={id:'a',messages:[]},store={state:{conversations:[chat,{id:'p',private:true,messages:[]}]}};let saves=0;
 const service=new OutcomeMarks({store,save:async()=>{saves++;},evaluate:()=>({decision:'allow'}),updater:async()=>({installed:{id:'c771c25b-aaaa',version:'0.6.1'},available:false,staged:null}),resolveFile:async file=>file,fetchImpl:async()=>json({}),process:async()=>({running:false,name:null}),now:()=>new Date('2026-10-25T03:00:00Z'),...overrides});
 return {service,chat,saves:()=>saves};
}
const check=(f,args)=>f.service.call({action:'check',...args},'a').then(result=>result.mark);

test('a mark’s status comes only from Exomina’s check, never from the claim',async()=>{
 const f=fixture();
 const right=await check(f,{kind:'update_installed',buildId:'c771c25b',claim:'0.6.1 is installed'});
 assert.equal(right.status,'verified');assert.equal(right.checkedBy,'exomina');assert.equal(right.observed.buildId,'c771c25b-aaaa');assert.equal(right.claim,'0.6.1 is installed');
 const wrong=await check(f,{kind:'update_installed',buildId:'a62538db',claim:'The update is installed',status:'verified'});
 assert.equal(wrong.status,'contradicted');assert.match(wrong.reason,/c771c25b/);
 assert.equal(OUTCOME_TOOL.inputSchema.properties.status,undefined,'agents cannot supply a status');
 assert.equal(f.chat.outcomeMarks.length,2);assert.equal(f.saves(),2);
});

test('a waiting update, a dead build process and a reused process ID are told apart',async()=>{
 const none=fixture();assert.equal((await check(none,{kind:'update_staged'})).status,'contradicted');
 const waiting=fixture({updater:async()=>({installed:{id:'a62538db'},available:true,staged:{id:'c771c25b-bbbb',version:'0.6.1'}})});
 assert.equal((await check(waiting,{kind:'update_staged'})).status,'verified');assert.equal((await check(waiting,{kind:'update_staged',buildId:'cc2cefc8'})).status,'contradicted');
 const dead=await check(none,{kind:'process_running',pid:4242,claim:'The build is still running'});
 assert.equal(dead.status,'contradicted');assert.match(dead.reason,/No process/);
 const reused=fixture({process:async()=>({running:true,name:'chrome.exe'})});
 assert.equal((await check(reused,{kind:'process_running',pid:4242,name:'node.exe'})).status,'contradicted');
 assert.equal((await check(reused,{kind:'process_running',pid:4242,name:'Chrome.exe'})).status,'verified');
});

test('Windows process lookup reads the exact process ID from tasklist',async()=>{
 const run=(output)=>(file,args,options,callback)=>{assert.equal(file,'tasklist');assert.deepEqual(args.slice(0,2),['/FI','PID eq 77']);callback(null,output);};
 assert.deepEqual(await processInfo(77,{platform:'win32',run:run('"node.exe","77","Console","1","50,000 K"\r\n')}),{running:true,name:'node.exe'});
 assert.deepEqual(await processInfo(77,{platform:'win32',run:run('INFO: No tasks are running which match the specified criteria.\r\n')}),{running:false,name:null});
 assert.deepEqual(await processInfo(77,{platform:'win32',run:run('"other.exe","770","Console","1","1 K"\r\n')}),{running:false,name:null});
 assert.equal((await processInfo(process.pid,{platform:'linux'})).running,true);
});

test('file checks hash the real bytes and respect the workspace boundary',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'exomina-outcomes-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'Setup.exe');await writeFile(file,'synthetic installer');const sha256=createHash('sha256').update('synthetic installer').digest('hex');
 const f=fixture({resolveFile:async value=>{if(value.includes('accounts'))throw Error('Exomina account stores and app data are outside the file tools.');if(value==='missing.exe'){const error=Error('missing');error.code='ENOENT';throw error;}return path.join(root,value);}});
 const good=await check(f,{kind:'file',path:'Setup.exe',sha256:sha256.toUpperCase(),minBytes:5});assert.equal(good.status,'verified');assert.equal(good.observed.sha256,sha256);
 assert.equal((await check(f,{kind:'file',path:'Setup.exe',sha256:'0'.repeat(64)})).status,'contradicted');
 assert.equal((await check(f,{kind:'file',path:'Setup.exe',minBytes:1e6})).status,'contradicted');
 assert.equal((await check(f,{kind:'file',path:'missing.exe'})).status,'contradicted');
 const blocked=await check(f,{kind:'file',path:'../accounts/token.json'});assert.equal(blocked.status,'refused');assert.equal(blocked.observed,undefined);
});

test('GitHub merge and check results are read from GitHub, with pending and failed runs reported',async()=>{
 const calls=[];const responses={'/repos/o/r/pulls/17':{state:'closed',merged:true,merged_at:'2026-10-25T03:10:00Z',merge_commit_sha:'abc1234def',head:{sha:'1b87317f557f'}},'/repos/o/r/pulls/15':{state:'open',merged:false,head:{sha:'9'}}};
 const f=fixture({fetchImpl:async url=>{calls.push(url);const u=new URL(url);if(u.pathname.includes('check-runs'))return json({total_count:3,check_runs:[{name:'validate',status:'completed',conclusion:'success'},{name:'publish',status:'completed',conclusion:'skipped'},{name:'native / macos',status:u.pathname.includes('/bad/')?'completed':'in_progress',conclusion:u.pathname.includes('/bad/')?'failure':null}]});return json(responses[u.pathname]||{message:'Not Found'},{status:responses[u.pathname]?200:404});}});
 assert.equal((await check(f,{kind:'github_pr_merged',repo:'o/r',number:17,sha:'1b87317'})).status,'verified');
 assert.equal((await check(f,{kind:'github_pr_merged',repo:'o/r',number:17,sha:'fffffff'})).status,'contradicted');
 assert.equal((await check(f,{kind:'github_pr_merged',repo:'o/r',number:15})).status,'contradicted');
 const missing=await check(f,{kind:'github_pr_merged',repo:'o/r',number:99});assert.equal(missing.status,'unavailable');assert.match(missing.reason,/Private repositories/);
 const running=await check(f,{kind:'github_checks',repo:'o/r',sha:'1b87317'});assert.equal(running.status,'contradicted');assert.deepEqual(running.observed.pending,['native / macos']);
 assert.equal(calls.every(url=>new URL(url).origin==='https://api.github.com'),true);
 const failing=fixture({fetchImpl:async()=>json({total_count:2,check_runs:[{name:'validate',status:'completed',conclusion:'success'},{name:'tests',status:'completed',conclusion:'failure'}]})});
 const failed=await check(failing,{kind:'github_checks',repo:'o/r',sha:'1b87317'});assert.equal(failed.status,'contradicted');assert.deepEqual(failed.observed.failing,['tests']);
 const passing=fixture({fetchImpl:async()=>json({total_count:2,check_runs:[{name:'validate',status:'completed',conclusion:'success'},{name:'publish',status:'completed',conclusion:'skipped'}]})});
 assert.equal((await check(passing,{kind:'github_checks',repo:'o/r',sha:'1b87317'})).status,'verified');
 const limited=fixture({fetchImpl:async()=>json({message:'rate limited'},{status:403,headers:{'x-ratelimit-remaining':'0'}})});
 assert.match((await check(limited,{kind:'github_checks',repo:'o/r',sha:'1b87317'})).reason,/rate limit/);
 const connected=fixture({github:{connected:true,get:async target=>{assert.equal(target,'/repos/o/r/pulls/17');return responses[target];}},fetchImpl:async()=>{throw Error('anonymous request used');}});
 assert.equal((await check(connected,{kind:'github_pr_merged',repo:'o/r',number:17})).status,'verified');
});

test('permission denials are recorded as refusals and the live policy is consulted on every check',async()=>{
 let denied=false;const f=fixture({evaluate:action=>{assert.equal(action.kind,'read');return denied?{decision:'deny',reason:'Blocked by your rule: outcome_verify'}:{decision:'allow'};}});
 assert.equal((await check(f,{kind:'update_installed',buildId:'c771c25b'})).status,'verified');denied=true;
 const refused=await check(f,{kind:'update_installed',buildId:'c771c25b'});assert.equal(refused.status,'refused');assert.match(refused.reason,/rule/);assert.equal(refused.observed,undefined);
 const policy=new PermissionPolicy({getSettings:()=>({permissionMode:'read-only',permissionRules:[]})});assert.equal(policy.evaluate(hostAction('outcome_verify',{action:'check',kind:'file',path:'x'}),'a').decision,'allow');
});

test('the log is append-only, bounded, per saved chat and readable newest first',async()=>{
 const f=fixture();for(let i=0;i<105;i++)await check(f,{kind:'update_installed',buildId:'c771c25b',claim:'mark '+i});
 assert.equal(f.chat.outcomeMarks.length,100);assert.equal(f.chat.outcomeMarks[0].claim,'mark 5');
 const view=await f.service.call({action:'view',limit:3},'a');assert.equal(view.total,100);assert.deepEqual(view.marks.map(mark=>mark.claim),['mark 104','mark 103','mark 102']);
 await assert.rejects(f.service.call({action:'check',kind:'update_installed',buildId:'c771c25b'},'p'),/saved chats/);
 await assert.rejects(f.service.call({action:'check',kind:'update_installed',buildId:'c77'},'a'),/8 characters/);
 await assert.rejects(f.service.call({action:'check',kind:'github_checks',repo:'../x',sha:'1b87317'},'a'),/owner\/name/);
 assert.equal(f.chat.outcomeMarks.length,100,'malformed requests are not marks');
});

test('outcome checks are offered in chat mode and follow-ups, labelled plainly, and named in the working method',()=>{
 assert.equal(LEAN_TOOLS.test('outcome_verify'),true);assert.equal(FOLLOWUP_READ_TOOLS.has('outcome_verify'),true);
 const label=describeTool('outcome_verify',{action:'check',kind:'process_running',claim:'The 0.6.1 build is running'});assert.equal(label.active,'Checking an outcome');assert.match(label.target,/0\.6\.1 build/);
 assert.match(workingInstructions,/check it with outcome_verify/);assert.match(workingInstructions,/may have stopped since/);
});
