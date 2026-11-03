import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnMspConnection} from '@muse-code/sdk';
import {MuseProvider,museEnvironment,museModels,museApprovalChoice,museMcp,museToolPrompt,applyMuseEvent} from '../desktop/provider-muse.mjs';
test('Muse subscription environment isolates homes and removes paid API keys and competing account credentials',()=>{
  const env=museEnvironment({PATH:'safe',META_API_KEY:'private',MUSE_TRANSPORT_TRACE:'1',OPENAI_API_KEY:'private',OTHER_TOKEN:'private'},'C:\\private\\muse');
  assert.equal(env.PATH,'safe');for(const key of ['META_API_KEY','MUSE_TRANSPORT_TRACE','OPENAI_API_KEY','OTHER_TOKEN'])assert.equal(env[key],undefined);assert.equal(env.USERPROFILE,'C:\\private\\muse');assert.equal(env.XDG_CONFIG_HOME,path.join('C:\\private\\muse','.config'));
});
test('Wonder and Wonder Full are retained exactly as advertised by Muse, with model effort options',()=>{
  const result=museModels({source:'providerCatalog',models:[{providerId:'meta',modelId:'muse-wonder-1.0',displayLabel:'Muse Wonder',variants:['low','high','ultra'],defaultReasoningEffort:'high'},{providerId:'meta',modelId:'muse-wonder-full',displayLabel:'Muse Wonder Full',variants:['max']},{providerId:'local',modelId:'not-the-subscription'}]});
  assert.deepEqual(result.map(m=>m.id),['muse-wonder-1.0','muse-wonder-full']);assert.equal(result[0].efforts.at(-1).id,'ultra');assert.equal(result[0].defaultEffort,'high');assert.deepEqual(museModels({models:[]}),[]);assert.equal(museModels({models:[{providerId:'meta',modelId:'muse-wonder-full-1.0',displayLabel:'muse-wonder-full-1.0'}]})[0].label,'Muse Wonder Full');
});
test('native approval choices cannot turn a single approval into a persistent grant',()=>{
  const request={availableChoices:[{choiceId:'persistent',decision:'approvedForSession',scope:'session'},{choiceId:'once',decision:'approved',scope:'once'},{choiceId:'deny',decision:'denied',scope:'once'}]};assert.equal(museApprovalChoice(request,true).choiceId,'once');assert.equal(museApprovalChoice(request,false).choiceId,'deny');assert.equal(museApprovalChoice({availableChoices:[request.availableChoices[0]]},true),undefined);
});
test('shared tools are connected only to the authenticated local gateway and originating chat',()=>{
  assert.deepEqual(museMcp({},'chat'),{});const config=museMcp({script:'bridge.cjs',url:'http://127.0.0.1:1',token:'fixture'},'chat');assert.equal(config.exomina.transport,'stdio');assert.equal(config.exomina.env.EXOMINA_TOOL_CONVERSATION,'chat');assert.equal(config.exomina.env.EXOMINA_TOOL_TOKEN,'fixture');
});
test('Muse command guidance states the actual permission boundary and retains the user prompt',()=>{
  const prompt=museToolPrompt('Synthetic user request.',true);assert.match(prompt,/workspace_shell/);assert.match(prompt,/not an OS sandbox/);assert.match(prompt,/deny rules/);assert.ok(prompt.endsWith('Synthetic user request.'));assert.equal(museToolPrompt('fixture',false),'fixture');
});
test('Muse streams text once, preserves tool failures and ignores other sessions',()=>{
  const state={sessionId:'session',conversationId:'chat',museKinds:new Map(),museLengths:new Map()},deltas=[],tools=[];
  const manager={delta:(s,text)=>deltas.push(text),toolStep:(s,value)=>tools.push(value),emit:()=>{}};
  const event=(method,item)=>({method,params:{sessionId:'session',item}});
  applyMuseEvent(event('item/started',{itemId:'answer',kind:'agentMessage',text:'Hello',status:'inProgress'}),state,manager);
  applyMuseEvent({method:'item/delta',params:{sessionId:'session',itemId:'answer',delta:' world',field:'text'}},state,manager);
  applyMuseEvent(event('item/completed',{itemId:'answer',kind:'agentMessage',text:'Hello world',status:'completed'}),state,manager);
  applyMuseEvent(event('item/completed',{itemId:'tool',kind:'toolCall',tool:'shell',status:'failed',failureReason:'Fixture failure',args:'{"command":"fixture"}'}),state,manager);
  applyMuseEvent({method:'item/delta',params:{sessionId:'other',itemId:'answer',delta:'ignored'}},state,manager);
  assert.equal(deltas.join(''),'Hello world');assert.equal(tools[0].status,'error');assert.equal(tools[0].output,'Fixture failure');
});
test('real official Muse MSP host completes an echo turn through the adapter without using a subscription or API',{skip:!existsSync(new URL('../vendor/muse/muse.exe',import.meta.url))?'Official echo-host binary is not bundled in this source tree.':false},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'exomina-muse-echo-'));const events=[];
  const manager={dataDir:directory,workspace:path.join(directory,'workspace'),prepare:async()=>mkdir(path.join(directory,'workspace'),{recursive:true}),environment:()=>({...process.env}),getPermissionMode:()=> 'read-only',approveDetailed:async()=>({approved:false}),emit:event=>events.push(event),delta:(state,text)=>{state.text+=text;},toolStep:()=>{},gateway:null};
  const hosts=[];const adapter=new MuseProvider(manager,{spawnMsp:options=>{hosts.push(options);return spawnMspConnection(options);}});const original=adapter.open.bind(adapter);adapter.open=options=>original({...options,provider:'echo'});adapter.savedLogin=async()=>true;
  try{const state={conversationId:'fixture',text:'',cancelled:false};const result=await adapter.run({prompt:'Synthetic Muse fixture',workspace:manager.workspace},state);assert.match(result.text,/Synthetic Muse fixture/);assert.equal(result.provider,'muse-code');assert.equal(adapter.hosts.size,0);assert.ok(hosts[0].args.includes('--disable-shell'));assert.ok(hosts[0].args.includes('--sandbox-network'));assert.ok(!hosts[0].args.includes('--disable-sandbox'));}finally{adapter.close();await rm(directory,{recursive:true,force:true});}
});
test('concurrent Muse profile preparation keeps every new folder encrypted under an EFS data directory',{skip:process.platform!=='win32'},async()=>{
  const {execFileSync}=await import('node:child_process'),root=await mkdtemp(path.join(tmpdir(),'exomina-muse-efs-'));
  try{
    try{execFileSync(path.join(process.env.SystemRoot,'System32','cipher.exe'),['/e','/b',root],{stdio:'ignore'});}catch{return;}
    for(let round=0;round<12;round++){
      const dataDir=path.join(root,'r'+round);await mkdir(dataDir);
      const adapter=new MuseProvider({dataDir,prepare:async()=>{}});
      const profiles=await Promise.all(Array.from({length:4},()=>adapter.profile()));assert.deepEqual(new Set(profiles),new Set([path.join(dataDir,'muse-home')]));
    }
    const listing=execFileSync('powershell.exe',['-NoProfile','-Command',`@(Get-ChildItem -LiteralPath '${root}' -Recurse -Force -Directory | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::Encrypted) } | ForEach-Object FullName) -join [char]10`],{encoding:'utf8'}).trim();
    assert.equal(listing,'');
  }finally{await rm(root,{recursive:true,force:true});}
});
