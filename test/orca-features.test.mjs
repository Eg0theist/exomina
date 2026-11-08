import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FeaturePackages,validateFeatureManifest} from '../desktop/feature-packages.mjs';
import {ExternalMcpTools} from '../desktop/external-mcp.mjs';
import {TaskWorkspaces} from '../desktop/task-workspaces.mjs';
import {BrowserFeedback,feedbackUrl} from '../desktop/browser-feedback.mjs';
import {hostAction,PermissionPolicy} from '../desktop/permissions.mjs';
import {featurePanelSource} from '../desktop/feature-panel.mjs';
import {phoneTerminalSnapshot} from '../desktop/phone-terminals.mjs';
import {REMOTE_METHODS} from '../desktop/remote-bridge.mjs';
const exec=promisify(execFile);
const temporary=()=>mkdtemp(path.join(tmpdir(),'exomina-orca-'));
async function packageSource(source,version,{broken=false}={}){
  await mkdir(source,{recursive:true});
  await writeFile(path.join(source,'exomina-feature.json'),JSON.stringify({id:'demo',name:'Demo',description:'Synthetic feature fixture',version,apiVersion:1,dataVersion:1,trust:'trusted-node',worker:'worker.mjs',panel:'panel.html',settings:[{key:'label',type:'string',label:'Label'}]}),'utf8');
  await writeFile(path.join(source,'panel.html'),'<p>Panel '+version+'</p>','utf8');
  await writeFile(path.join(source,'worker.mjs'),broken?'process.exit(7);':`import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(!request.id)return;let result={};if(request.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}}};if(request.method==='tools/list')result={tools:[{name:'ping',description:'Synthetic ping',inputSchema:{type:'object'}}]};if(request.method==='tools/call'){const file=path.join(process.env.EXOMINA_FEATURE_DATA,'counter.txt');let counter=0;try{counter=Number(readFileSync(file,'utf8'));}catch{}writeFileSync(file,String(++counter));result={content:[{type:'text',text:'${version}:'+counter}]};}console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));});`,'utf8');
}
async function packages(root){let servers=[],manager;const external=new ExternalMcpTools({approve:async()=>true,getSettings:()=>({externalMcpServers:servers}),launchApproved:config=>manager.verify(config),prepareCall:config=>manager.verify(config)});manager=await new FeaturePackages({root:path.join(root,'managed'),command:process.execPath,approve:async()=>true,exclude:async file=>{if(file.includes(path.sep+'managed'))throw Error('Private app data');},getServers:()=>servers,saveServers:async value=>{servers=value;},external}).init();return {manager,external,get servers(){return servers;}};}

test('feature generations reload worker+panel, preserve data, rollback, reject tampering and revoke queued calls',async()=>{
  const root=await temporary(),source=path.join(root,'source'),f=await packages(root);
  try{
    await packageSource(source,'1.0.0');const preview=await f.manager.preview(source);assert.ok(preview.sha256);await f.manager.activate(preview.previewId);
    const alias=f.external.definitions[0].name,pid=f.external.clients.get('pkg_demo').client.child.pid;
    assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.0.0:1');
    await f.manager.settings('demo',{label:'Persistent setting'});
    await packageSource(source,'1.1.0');await f.manager.activate((await f.manager.preview(source)).previewId);
    assert.notEqual(f.external.clients.get('pkg_demo').client.child.pid,pid);assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.1.0:2');assert.equal((await f.manager.view())[0].values.label,'Persistent setting');assert.match((await f.manager.view())[0].panel,/1.1.0/);
    await f.manager.change('demo','rollback');assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.0.0:3');
    await packageSource(source,'1.2.0',{broken:true});await assert.rejects(f.manager.activate((await f.manager.preview(source)).previewId),/previous generation was restored/);assert.equal((await f.external.call(alias,{},'chat')).content[0].text,'1.0.0:4');
    let grant;f.external.approve=()=>new Promise(resolve=>{grant=resolve;});const pending=f.external.call(alias,{},'chat');while(!grant)await new Promise(resolve=>setImmediate(resolve));await f.manager.change('demo','disable');grant(true);assert.equal((await pending).isError,true);assert.equal(f.external.definitions.length,0);
    await f.manager.change('demo','enable');f.external.approve=async()=>true;
    const record=f.manager.records.demo;await writeFile(path.join(f.manager.directory('demo',record.generation),'panel.html'),'Changed after approval','utf8');const changed=await f.external.call(alias,{},'chat');assert.equal(changed.isError,true);assert.match(changed.content[0].text,/contents changed/);assert.equal((await f.manager.view())[0].panel,null);
  }finally{await f.external.close();await rm(root,{recursive:true,force:true});}
});

test('package preview pins reviewed content; incompatible API, links and data migration fail closed',async()=>{
  const root=await temporary(),source=path.join(root,'source'),f=await packages(root);
  try{
    assert.throws(()=>validateFeatureManifest({id:'demo',name:'Demo',description:'Test',version:'1.0.0',apiVersion:2,panel:'x.html'}),/API/);
    await packageSource(source,'1.0.0');const preview=await f.manager.preview(source);await writeFile(path.join(source,'panel.html'),'Changed during review','utf8');await assert.rejects(f.manager.activate(preview.previewId),/source changed/);assert.equal(f.servers.length,0);
    await packageSource(source,'1.0.0');await f.manager.activate((await f.manager.preview(source)).previewId);
    const manifest=JSON.parse(await readFile(path.join(source,'exomina-feature.json'),'utf8'));manifest.dataVersion=2;await writeFile(path.join(source,'exomina-feature.json'),JSON.stringify(manifest),'utf8');await assert.rejects(f.manager.activate((await f.manager.preview(source)).previewId),/migration/);
    await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(source,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(f.manager.preview(source),/links/);
  }finally{await f.external.close();await rm(root,{recursive:true,force:true});}
});

test('coding worktrees isolate two tasks, omit ignored files, refuse dirty removal and keep branches',async()=>{
  const root=await temporary(),repository=path.join(root,'repository');await mkdir(repository);
  const git=args=>exec('git',args,{cwd:repository,windowsHide:true});
  try{
    await git(['init']);await git(['config','core.autocrlf','false']);await writeFile(path.join(repository,'file.txt'),'baseline\n','utf8');await writeFile(path.join(repository,'.gitignore'),'.env\n','utf8');await git(['add','.']);await git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','fixture']);await writeFile(path.join(repository,'.env'),'synthetic ignored file','utf8');
    const chats=[{id:'one'},{id:'two'}],manager=new TaskWorkspaces({root:path.join(root,'tasks'),getChat:id=>chats.find(chat=>chat.id===id),getWorkspace:()=>repository,save:async()=>{},approve:async()=>true});
    const first=await manager.create('one'),second=await manager.create('two');assert.notEqual(first.branch,second.branch);await writeFile(path.join(first.folder,'file.txt'),'first task\n','utf8');assert.equal(await readFile(path.join(second.folder,'file.txt'),'utf8'),'baseline\n');assert.equal(await readFile(path.join(repository,'file.txt'),'utf8'),'baseline\n');await assert.rejects(readFile(path.join(first.folder,'.env'),'utf8'),{code:'ENOENT'});
    assert.match((await manager.diff('one')).diff,/first task/);await assert.rejects(manager.remove('one'),/uncommitted/);await manager.remove('two');assert.equal(chats[1].taskWorkspace,undefined);assert.match((await git(['branch','--list',second.branch])).stdout,/exomina\/task-/);assert.equal(await readFile(path.join(first.folder,'file.txt'),'utf8'),'first task\n');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('visual feedback is bounded, excludes URL credentials/query and expires after navigation or revocation',async()=>{
  let enabled=true,url='https://example.invalid/page?private=1#fragment',revision=1;
  const page={getSettings:()=>({browserEnabled:enabled}),runtime:{get revision(){return revision;},execute:async()=>({tag:'button',html:'<button>Example</button>',styles:{color:'red'},screenshotAllowed:false})},wc:{isDestroyed:()=>false,getURL:()=>url}};
  const feedback=new BrowserFeedback(page);assert.equal(feedbackUrl('https://user:password@example.invalid/path?q=x#y'),'https://example.invalid/path');
  page.wc.executeJavaScriptInIsolatedWorld=()=>page.runtime.execute();
  let capture=await feedback.capture(1,2);assert.equal(capture.url,'https://example.invalid/page');assert.equal(feedback.take(capture.id).html,'<button>Example</button>');assert.throws(()=>feedback.take(capture.id),/expired/);
  capture=await feedback.capture(1,2);revision++;assert.throws(()=>feedback.take(capture.id),/changed/);capture=await feedback.capture(1,2);enabled=false;assert.throws(()=>feedback.take(capture.id),/changed/);await assert.rejects(feedback.capture(1,2),/off/);
});

test('feature and workspace actions have explicit read versus execute policy kinds',()=>{
  assert.equal(hostAction('feature_package',{action:'preview'}).kind,'read');assert.equal(hostAction('feature_package',{action:'enable'}).kind,'execute');assert.equal(hostAction('task_workspace',{action:'diff'}).kind,'read');assert.equal(hostAction('task_workspace',{action:'remove'}).kind,'execute');
});

test('feature approvals reject misleading labels, cross-chat previews, retained data migrations and corrupt settings',async()=>{
  const root=await temporary(),source=path.join(root,'source'),f=await packages(root);
  try{
    for(const id of ['constructor','nul','com1'])assert.throws(()=>validateFeatureManifest({id,name:'Demo',description:'Demo',version:'1.0.0',apiVersion:1,panel:'x.html'}));
    assert.throws(()=>validateFeatureManifest({id:'demo',name:'Demo',description:'Description\nStatic panel',version:'1.0.0',apiVersion:1,panel:'x.html'}),/single-line/);
    await packageSource(source,'1.0.0');const preview=await f.manager.preview(source,'owner');await assert.rejects(f.manager.activate(preview.previewId,'other'),/belongs/);await f.manager.activate(preview.previewId,'owner');
    await writeFile(path.join(root,'managed','demo','data','settings.json'),'{broken','utf8');assert.match((await f.manager.view())[0].error,/settings/);await f.manager.change('demo','disable');assert.equal((await f.manager.view())[0].enabled,false);
    await f.manager.change('demo','remove');const manifest=JSON.parse(await readFile(path.join(source,'exomina-feature.json'),'utf8'));manifest.dataVersion=2;await writeFile(path.join(source,'exomina-feature.json'),JSON.stringify(manifest),'utf8');await assert.rejects(f.manager.activate((await f.manager.preview(source)).previewId),/Retained feature data/);
  }finally{await f.external.close();await rm(root,{recursive:true,force:true});}
});

test('static panels drop scripts, nested navigation and network URLs before creating a frame',()=>{
  const result=featurePanelSource('<meta http-equiv="refresh" content="0;url=https://bad.invalid"><script>BAD_SCRIPT</script><iframe src="https://bad.invalid"></iframe><a href="https://bad.invalid">Link text</a><div onclick="BAD_HANDLER" style="color:red">Good</div><img src="https://bad.invalid/track">');
  assert.match(result,/Good/);assert.match(result,/Link text/);assert.doesNotMatch(result,/bad\.invalid|BAD_SCRIPT|BAD_HANDLER|<iframe|<a /);assert.match(result,/default-src 'none'/);
});

test('phone terminal output is opt-in, bounded, chat-owned and rechecked after asynchronous reads',async()=>{
  let allowed=false;const chats=[{id:'chat'},{id:'private',private:true}];const sessions=[{id:'agent',conversationId:'chat',owner:'agent',baseCursor:0,nextCursor:12000},{id:'personal',conversationId:'chat',owner:'user'},{id:'private-session',conversationId:'private',owner:'agent'}];
  const options={terminals:{sessions:new Map(sessions.map(session=>[session.id,session])),read:async args=>{assert.equal(args.limit,8000);return {text:'x'.repeat(10_000),status:'running'};}},getChats:()=>chats,outputAllowed:()=>allowed,checkRead:()=>{}};
  assert.deepEqual((await phoneTerminalSnapshot(options)).sessions.map(item=>item.id),['agent']);await assert.rejects(phoneTerminalSnapshot(options,{id:'agent',conversationId:'chat'}),/off/);allowed=true;assert.equal((await phoneTerminalSnapshot(options,{id:'agent',conversationId:'chat'})).output.text.length,8000);await assert.rejects(phoneTerminalSnapshot(options,{id:'agent',conversationId:'other'}),/unavailable/);
  options.terminals.read=async()=>{allowed=false;return {text:'must not leave computer',status:'running'};};await assert.rejects(phoneTerminalSnapshot(options,{id:'agent',conversationId:'chat'}),/changed/);
  assert.deepEqual(REMOTE_METHODS['phone.work']({id:'agent',conversationId:'chat',text:'never input',permissionMode:'full'}),{id:'agent',conversationId:'chat'});assert.equal(REMOTE_METHODS['terminal.input'],undefined);
});

test('coding workspace ignores executable planted in the checkout and disables clean filters on review',async()=>{
  const root=await temporary(),repository=path.join(root,'repository');await mkdir(repository);const git=args=>exec('git',args,{cwd:repository,windowsHide:true});
  try{
    await git(['init']);await git(['config','core.autocrlf','false']);await writeFile(path.join(repository,'file.txt'),'original\n','utf8');await writeFile(path.join(repository,'.gitattributes'),'file.txt filter=synthetic\n','utf8');await writeFile(path.join(repository,'.gitignore'),'ignored.txt\n','utf8');await git(['add','.']);await git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-m','fixture']);
    await git(['config','filter.synthetic.clean','node -e "require(\'fs\').writeFileSync(\'filter-ran.txt\',\'bad\')"']);
    await writeFile(path.join(repository,process.platform==='win32'?'git.exe':'git'),'INVALID LOCAL GIT','utf8');
    const chat={id:'one'},manager=new TaskWorkspaces({root:path.join(root,'tasks'),getChat:()=>chat,getWorkspace:()=>repository,save:async()=>{},approve:async()=>true});const record=await manager.create('one');await writeFile(path.join(record.folder,'file.txt'),'changed\n','utf8');await manager.diff('one');await assert.rejects(readFile(path.join(record.folder,'filter-ran.txt'),'utf8'),{code:'ENOENT'});
    await writeFile(path.join(record.folder,'file.txt'),'original\n','utf8');await writeFile(path.join(record.folder,'ignored.txt'),'keep ignored work','utf8');await assert.rejects(manager.remove('one'),/ignored/);await manager.forget('one');assert.equal(chat.taskWorkspace,undefined);assert.equal(await readFile(path.join(record.folder,'ignored.txt'),'utf8'),'keep ignored work');
  }finally{await rm(root,{recursive:true,force:true});}
});
