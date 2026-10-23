import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,link,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {GhidraProvider} from 'rea-agents/dist/ghidra/GhidraProvider.js';
import {NATIVE_QUERIES,NATIVE_LIMITS,inspectNativeDependencies,validateNativeQuery,runNativeAnalysis} from '../desktop/app-analysis-native.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inertPe=({managed=false,dll=false}={})=>{
  const bytes=Buffer.alloc(512);bytes.write('MZ');bytes.writeUInt32LE(128,60);bytes.write('PE\0\0',128,'binary');bytes.writeUInt16LE(0x8664,132);bytes.writeUInt16LE(240,148);bytes.writeUInt16LE(0x22|(dll?0x2000:0),150);bytes.writeUInt16LE(0x20b,152);bytes.writeUInt32LE(16,260);if(managed)bytes.writeUInt32LE(4096,376);return bytes;
};
async function fixture(t,bytes=inertPe()){
  const root=await mkdtemp(path.join(tmpdir(),'exomina-native-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'example.exe'),bytes);
  return {root,request:{snapshot:root,operation:'native',files:[{path:'example.exe',bytes:bytes.length,sha256:sha(bytes)}]}};
}
function fakeProvider({values={},execute,close}={}){
  const calls=[],targets=[],events=[],provider=new GhidraProvider({},{},{});let closes=0;
  return {calls,targets,events,get closes(){return closes;},factory:()=>({
    inspectAvailability:async()=>({status:'available'}),inspectTargetSupport:target=>provider.inspectTargetSupport(target),
    resolveAnalysisProfile:async()=>({ok:true,value:{profile:{digest:'a'.repeat(64)}}}),
    createClient:target=>{targets.push(target);return {execute:async(operation,args,options)=>{
      calls.push({operation,args,signal:options.signal});if(execute)return execute(operation,args,options);
      return {ok:true,value:{result:values[operation]??(operation==='health'?{read_only:true,analysis_complete:true}:[]),provider:{id:'ghidra',version:'12.1.4'},analysisProfile:{digest:'a'.repeat(64)},limitations:['Observed by Ghidra.']}};
    },close:async()=>{closes++;if(close)await close();}};}
  })};
}
test('the shared native contract exposes all 25 supported read-only queries',()=>{
  assert.equal(NATIVE_QUERIES.length,25);assert.equal(new Set(NATIVE_QUERIES).size,25);assert.ok(!NATIVE_QUERIES.includes('annotate_native_function'));
  for(const operation of ['analyze_function','procedure_references','inspect_native_load_image','resolve_native_call_targets'])assert.ok(NATIVE_QUERIES.includes(operation));
});
test('dependency diagnostics explain actual prerequisites without native target execution',async()=>{
  const result=await inspectNativeDependencies();assert.equal(result.status,'unavailable');assert.equal(result.code,'not_configured');assert.equal(result.requirements.ghidraVersion,'12.1.4');assert.equal(result.requirements.ghidraReleaseLine,'12.1.x');assert.equal(result.requirements.targetExecution,false);assert.match(result.requirements.java,/full JDK/);assert.match(result.requirements.targets,/native Windows x86\/x64 EXE/);assert.match(result.requirements.targets,/not yet integrated and verified in Exomina/);assert.match(result.requirements.targets,/Ghidra itself supports a wider range/);
  for(const config of [{ghidraInstallDir:'relative'}, {ghidraJavaHome:'C:\\fixture & whoami'}, {ghidraInstallDir:'C:\\fixture\nunsafe'}])await assert.rejects(inspectNativeDependencies(config),/absolute directories/);
});

test('asynchronous dependency refusal closes owned resources before any target reaches Ghidra',async t=>{
  const {request}=await fixture(t);let inspected=false,closed=false;
  const provider={inspectAvailability:async()=>{await new Promise(resolve=>setImmediate(resolve));inspected=true;return {status:'unavailable',reason:'Synthetic unavailable installation'};},inspectTargetSupport:()=>assert.fail('Unavailable provider must not inspect a target'),closeOwnedResources:async()=>{closed=true;return {ok:true};}};
  await assert.rejects(runNativeAnalysis(request,{providerFactory:()=>provider}),/Synthetic unavailable installation/);
  assert.equal(inspected,true);assert.equal(closed,true);
});

test('provider cleanup failures cannot be reported as successful native analysis',async t=>{
  const {request}=await fixture(t),fake=fakeProvider();
  await assert.rejects(runNativeAnalysis(request,{providerFactory:()=>({...fake.factory(),closeOwnedResources:async()=>({ok:false,error:Error('Provider cleanup incomplete')})})}),/Provider cleanup incomplete/);
  assert.equal(fake.closes,1);
});
test('query validation refuses mutation, unknown arguments and oversized reads before provider creation',async t=>{
  const {request}=await fixture(t);let created=0;
  for(const query of [{operation:'annotate_native_function',args:{}},{operation:'shutdown',args:{}},{operation:'read_bytes',args:{address:'0x140001000',length:4097}},{operation:'read_bytes',args:{address:'0x140001000',length:0}},{operation:'list_strings',args:{execute:'bad'}},{operation:'search_strings',args:{pattern:'\0'}}])await assert.rejects(runNativeAnalysis({...request,nativeQuery:query},{providerFactory:()=>{created++;}}));
  assert.equal(created,0);
  assert.equal(validateNativeQuery({operation:'read_bytes',args:{address:'0x140001000'}}).args.length,256);
  assert.throws(()=>validateNativeQuery({operation:'list_strings',limit:101}),/between 1 and 100/);
});
test('native overview commits snapshot identity and queries one read-only owned session',async t=>{
  const {root,request}=await fixture(t),fake=fakeProvider({values:{list_procedures:[{address:'0x140001000',value:'rea_score',procedure:{external:false,thunk:false}}],list_names:[{address:'EXTERNAL:0x1',value:'GetTickCount',symbol:{external:true}}]}}),events=[];
  const result=await runNativeAnalysis(request,{providerFactory:fake.factory,onProgress:event=>events.push(event)});
  assert.equal(result.analyzedFiles,1);assert.equal(result.failures.length,0);assert.equal(result.files[0].sha256,request.files[0].sha256);assert.equal(result.files[0].result.target.managed,false);assert.equal(result.files[0].result.target.architecture,'x86_64');assert.equal(fake.targets[0].sourcePath,path.join(root,'example.exe'));assert.equal(fake.closes,1);
  assert.deepEqual(fake.calls.map(call=>call.operation),['health','list_documents','list_segments','list_procedures','list_strings','list_names']);assert.ok(events.some(event=>event.stage==='cleanup'));
});
test('managed and DLL applications are rejected from experimental Windows native engine',async t=>{
  for(const options of [{managed:true},{dll:true}]){
    const {request}=await fixture(t,inertPe(options)),fake=fakeProvider(),result=await runNativeAnalysis(request,{providerFactory:fake.factory});
    assert.equal(result.files.length,0);assert.equal(fake.calls.length,0);assert.equal(fake.targets.length,0);assert.equal(result.failures.length,1);assert.match(result.failures[0].error,/managed|DLL/i);assert.match(result.failures[0].error,options.managed?/separate \.NET inspections/:/not yet integrated and verified in Exomina/);assert.match(result.limitations.join(' '),/Ghidra itself supports a wider range/);
  }
});
test('changed hashes, path traversal, links and hard links never reach Ghidra',async t=>{
  const {root,request}=await fixture(t),outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'copied.exe'),inertPe());
  const hard=path.join(root,'hard.exe');await link(path.join(root,'example.exe'),hard);
  const linked=path.join(root,'linked.exe');await symlink(path.join(outside,'copied.exe'),linked,'file');
  for(const entry of [{...request.files[0],sha256:'b'.repeat(64)},{...request.files[0],path:'../example.exe'},{...request.files[0],path:'hard.exe'},{...request.files[0],path:'linked.exe'}]){
    const fake=fakeProvider(),result=await runNativeAnalysis({...request,files:[entry]},{providerFactory:fake.factory});assert.equal(result.failures.length,1);assert.equal(fake.calls.length,0);
  }
});
test('query inventory pagination retains total and canonical addresses',async t=>{
  const {request}=await fixture(t),names=Array.from({length:250},(_,index)=>({address:`0x${(0x140001000+index).toString(16)}`,value:`function_${index}`})),fake=fakeProvider({values:{list_names:names}});
  const result=await runNativeAnalysis({...request,operation:'native-query',nativeQuery:{operation:'list_names',offset:100,limit:100}},{providerFactory:fake.factory}),observation=result.files[0].result.observations[1];
  assert.equal(observation.result.length,100);assert.equal(observation.result[0].value,'function_100');assert.deepEqual(observation.pagination,{offset:100,limit:100,total:250,nextOffset:200});assert.equal(observation.truncated,true);assert.equal(fake.closes,1);
});
test('bounded function evidence records truncation instead of silently claiming complete source',async t=>{
  const {request}=await fixture(t),pseudo='a'.repeat(NATIVE_LIMITS.textBytes+1),fake=fakeProvider({values:{procedure_pseudo_code:pseudo}});
  const result=await runNativeAnalysis({...request,operation:'native-query',nativeQuery:{operation:'procedure_pseudo_code',args:{procedure:'0x140001000'}}},{providerFactory:fake.factory}),observation=result.files[0].result.observations[1];
  assert.equal(Buffer.byteLength(observation.result),NATIVE_LIMITS.textBytes);assert.equal(observation.truncated,true);assert.equal(observation.truncations[0].originalBytes,pseudo.length);assert.match(result.limitations.join(' '),/not the original/);
});
test('function sampling skips externals and thunks and caps detailed functions at three',async t=>{
  const {request}=await fixture(t),procedures=[{address:'0x1',procedure:{external:true,thunk:false}},{address:'0x2',procedure:{external:false,thunk:true}},...Array.from({length:8},(_,index)=>({address:`0x${index+3}`,procedure:{external:false,thunk:false}}))],fake=fakeProvider({values:{list_procedures:procedures,analyze_function:{pseudocode:'int rea_score(int x) { return x == 7 ? 4242 : 3*x + 11; }'}}});
  const result=await runNativeAnalysis({...request,operation:'native-functions'},{providerFactory:fake.factory});assert.deepEqual(fake.calls.filter(call=>call.operation==='analyze_function').map(call=>call.args.procedure),['0x3','0x4','0x5']);assert.match(result.files[0].result.limitations.join(' '),/sample/);assert.equal(fake.closes,1);
});
test('specific function requests preserve requested canonical selector',async t=>{
  const {request}=await fixture(t),fake=fakeProvider();await runNativeAnalysis({...request,operation:'native-functions',procedure:'0x140001000'},{providerFactory:fake.factory});assert.equal(fake.calls.find(call=>call.operation==='analyze_function').args.procedure,'0x140001000');
});
test('provider errors retain evidence failure and close its owned session',async t=>{
  const {request}=await fixture(t),fake=fakeProvider({execute:async()=>({ok:false,error:Object.assign(Error('Ghidra refused the selected artifact'),{_tag:'AnalysisArtifactChangedError',diagnostics:{token:'must never leak',reason:'identity changed'}})})}),result=await runNativeAnalysis(request,{providerFactory:fake.factory});
  assert.equal(result.files.length,0);assert.equal(result.failures[0].code,'AnalysisArtifactChangedError');assert.equal(result.failures[0].diagnostics.token,'[REDACTED]');assert.equal(fake.closes,1);
});
test('active cancellation reaches REA signal and waits for owned-session cleanup',async t=>{
  const {request}=await fixture(t),controller=new AbortController();let resolveStarted;const started=new Promise(resolve=>{resolveStarted=resolve;});
  const fake=fakeProvider({execute:async(operation,args,{signal})=>{resolveStarted();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {ok:false,error:Error('cancelled by REA')};}});
  const promise=runNativeAnalysis(request,{providerFactory:fake.factory,signal:controller.signal});await started;controller.abort();await assert.rejects(promise,/cancelled/);assert.equal(fake.closes,1);
});
test('unconfirmed native cleanup fails closed',async t=>{
  const {request}=await fixture(t),fake=fakeProvider({close:async()=>{throw Error('Owned job cleanup incomplete');}});await assert.rejects(runNativeAnalysis(request,{providerFactory:fake.factory}),/cleanup incomplete/);assert.equal(fake.closes,1);
});
test('generic queries need an unambiguous single selected file',async t=>{
  const {request}=await fixture(t),fake=fakeProvider();await assert.rejects(runNativeAnalysis({...request,files:[...request.files,{...request.files[0],path:'another.exe'}],nativeQuery:{operation:'list_procedures'}},{providerFactory:fake.factory}),/Choose one/);await assert.rejects(runNativeAnalysis({...request,nativeFile:'../example.exe'},{providerFactory:fake.factory}),/safe relative/);
});
