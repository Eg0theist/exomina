// Real production AppAnalysis -> isolated worker -> REA -> Ghidra verification.
// All app profiles and target files are fresh synthetic fixtures. No sign-in or model call.
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||sourceRoot);
const nodeExecutable=process.env.EXOMINA_QA_NODE_EXECUTABLE||process.execPath;
const setupBase=path.resolve(process.env.EXOMINA_QA_NATIVE_BASE||path.join(sourceRoot,'../Workspace/rea-native-verification'));
const setup=process.env.EXOMINA_QA_NATIVE_SETUP?JSON.parse(process.env.EXOMINA_QA_NATIVE_SETUP):{ghidraPath:path.join(setupBase,'ghidra','ghidra_12.1.4_PUBLIC'),javaPath:path.join(setupBase,'jdk','jdk-21.0.12.1+1')};
const originalFixture=process.env.EXOMINA_QA_NATIVE_TARGET||path.join(setupBase,'rea-native-fixture.exe');
const output=await mkdtemp(path.join(path.resolve(sourceRoot,'../Workspace'),'qa-native-backend-'));
const profile=path.join(output,'profile'),workspace=path.join(output,'workspace');
await Promise.all([mkdir(profile),mkdir(workspace)]);
const {AppAnalysis}=await import(pathToFileURL(path.join(runtimeRoot,'desktop','app-analysis.mjs')));
const {WorkspaceTools}=await import(pathToFileURL(path.join(runtimeRoot,'desktop','workspace-tools.mjs')));
const target=path.join(workspace,'rea-native-fixture.exe');await copyFile(originalFixture,target);
const approvals=[],events=[],chats=new Map([['one',{id:'one'}]]);let deniedTool=null,cancelWhenImporting=false,cancelScheduled=false;
const approve=async request=>{approvals.push({tool:request.action?.tool,target:request.action?.target});return request.action?.tool!==deniedTool;};
const workspaceTools=new WorkspaceTools({dataDir:profile,privateDirs:[],getSettings:()=>({workspace}),approve});
const tools=new AppAnalysis({dataDir:profile,workspaceTools,getChat:id=>chats.get(id),approve,nodeExecutable,emit:event=>{
  events.push({type:event.type,phase:tools.runs.get('one')?.phase||null});
  if(cancelWhenImporting&&!cancelScheduled&&tools.runs.get('one')?.phase==='Importing executable in Ghidra'){
    cancelScheduled=true;setTimeout(()=>tools.cancel('one'),1500);
  }
}});
const report={runtimeRoot,nodeExecutable,output,scope:'Real production analysis backend and worker with Ghidra/full JDK, synthetic approved PE fixture only. No target executable is launched, app account stores are not read, and no provider sign-in or model request occurs.',checks:{},errors:[]};
const unpack=result=>JSON.parse(result.content[0].text);
async function saved(id){
  let text='',offset=0;
  while(true){const chunk=unpack(await tools.call('analysis_report',{id,offset,limit:64000},'one'));text+=chunk.text;if(chunk.nextOffset===null)break;offset=chunk.nextOffset;}
  return JSON.parse(text);
}
async function noScratch(){
  let names=[];try{names=await readdir(tools.folder('one'));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const name of names)for(const entry of ['snapshot','home','request.json'])await assert.rejects(access(path.join(tools.folder('one'),name,entry)),/ENOENT/);
  assert.equal(tools.busy,false);
}
async function nativeProcesses(){
  if(process.platform!=='win32')return [];
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const args=['-NoLogo','-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('java.exe','decompile.exe') } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"];
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>{if(code!==0)return reject(Error(stderr));const value=stdout.trim()?JSON.parse(stdout):[];resolve(Array.isArray(value)?value:[value]);});
  });
}
async function run(tool,args){
  const result=await tools.call(tool,args,'one'),summary=unpack(result),evidence=summary.id?await saved(summary.id):null;await noScratch();return {result,summary,evidence};
}
const originalBytes=await readFile(target),originalDigest=createHash('sha256').update(originalBytes).digest('hex');
try{
  const configured=await tools.configureNative(setup);report.dependencyProbe=configured;assert.equal(configured.available,true);assert.equal(configured.diagnostics.provider_version,'12.1.4');assert.match(configured.diagnostics.java_version,/^21\./);
  report.checks.actualDependencies={nativeControls:true,ghidra:configured.diagnostics.provider_version,java:configured.diagnostics.java_version};
  await tools.select('one',target);
  let result=await run('analysis_run',{operation:'native'});assert.equal(result.summary.status,'completed');assert.equal(result.summary.failures,0);assert.equal(result.evidence.evidence.files[0].sha256,originalDigest);
  const observations=result.evidence.evidence.files[0].result.observations,procedures=observations.find(item=>item.operation==='list_procedures').result,strings=observations.find(item=>item.operation==='list_strings').result;
  assert.ok(procedures.some(item=>item.value==='rea_score'));assert.ok(strings.some(item=>item.value.includes('EXOMINA_REA_NATIVE_FIXTURE_20261009')));assert.equal(observations[0].result.read_only,true);assert.equal(observations[0].result.analysis_complete,true);
  report.checks.nativeOverview={sha256:originalDigest,readOnlyImport:true,functions:procedures.length,fixtureMarker:true};
  result=await run('analysis_run',{operation:'native-functions',procedure:'rea_score'});assert.equal(result.summary.status,'completed');assert.equal(result.summary.failures,0);
  const dossier=result.evidence.evidence.files[0].result.observations.find(item=>item.operation==='analyze_function').result;
  assert.equal(dossier.procedure.name,'rea_score');assert.match(dossier.pseudocode,/4242|0x1092/i);assert.match(dossier.pseudocode,/\* 3|3 \*/);assert.ok(dossier.procedure.body.provenance.includes('ghidra'));
  report.checks.nativeDecompilation={procedure:dossier.procedure.name,entrypoint:dossier.procedure.address,pseudocodeContainsCompiledBranches:true,functionBodyEvidence:true};
  const approvalStart=approvals.length;result=await run('analysis_native',{operation:'list_procedures',offset:0,limit:1});assert.equal(result.summary.status,'completed');const inventory=result.evidence.evidence.files[0].result.observations.find(item=>item.operation==='list_procedures');assert.equal(inventory.result.length,1);assert.equal(inventory.pagination.limit,1);assert.ok(inventory.pagination.total>1);assert.equal(inventory.pagination.nextOffset,1);assert.ok(approvals.slice(approvalStart).some(item=>item.tool==='analysis_native'));
  report.checks.genericNativePagination={oneResult:true,total:inventory.pagination.total,nextOffset:1,correctPermissionAlias:true};
  deniedTool='analysis_native';const beforeDenied=(await tools.status('one')).reports.length;
  await assert.rejects(tools.call('analysis_native',{operation:'procedure_pseudo_code',arguments:{procedure:'rea_score'}},'one'),/declined/);assert.equal((await tools.status('one')).reports.length,beforeDenied);assert.equal(tools.busy,false);deniedTool=null;
  report.checks.deniedNativePermissionCreatesNoWorkerOrReport=true;
  result=await run('analysis_native',{operation:'procedure_pseudo_code',arguments:{procedure:'EXOMINA_MISSING_FUNCTION_20261009'}});assert.equal(result.summary.status,'failed');assert.equal(result.result.isError,true);assert.equal(result.summary.evidenceFiles,0);assert.equal(result.summary.failures,1);
  report.checks.failedQueryCannotClaimCompletion=true;
  const unsupported=Buffer.from(originalBytes),header=unsupported.readUInt32LE(60);unsupported.writeUInt16LE(unsupported.readUInt16LE(header+22)|0x2000,header+22);const unsupportedTarget=path.join(workspace,'unsupported-dll.exe');await writeFile(unsupportedTarget,unsupported);await tools.select('one',unsupportedTarget);
  result=await run('analysis_run',{operation:'native'});assert.equal(result.summary.status,'failed');assert.equal(result.result.isError,true);assert.match(result.evidence.evidence.failures[0].error,/DLL/);report.checks.unsupportedDllIsExplicitFailure=true;
  const malformedTarget=path.join(workspace,'malformed.exe');await writeFile(malformedTarget,'MZ malformed inert fixture');await tools.select('one',malformedTarget);
  result=await run('analysis_run',{operation:'native'});assert.equal(result.summary.status,'failed');assert.equal(result.result.isError,true);assert.ok(result.evidence.evidence.failures.length>0);report.checks.malformedExecutableIsExplicitFailure=true;
  await tools.select('one',target);deniedTool='analysis_run';const deniedOverviewBefore=(await tools.status('one')).reports.length;await assert.rejects(tools.call('analysis_run',{operation:'native'},'one'),/declined/);assert.equal((await tools.status('one')).reports.length,deniedOverviewBefore);deniedTool=null;report.checks.deniedOverviewDoesNotCopyTarget=true;
  const processBefore=await nativeProcesses(),baseline=new Set(processBefore.map(item=>item.ProcessId)),reportsBeforeCancel=(await tools.status('one')).reports.length;
  cancelWhenImporting=true;await assert.rejects(tools.call('analysis_run',{operation:'native-functions',procedure:'rea_score'},'one'),/cancelled/i);cancelWhenImporting=false;await noScratch();assert.equal(cancelScheduled,true);assert.equal((await tools.status('one')).reports.length,reportsBeforeCancel);
  const leftovers=(await nativeProcesses()).filter(item=>!baseline.has(item.ProcessId));assert.deepEqual(leftovers,[]);report.checks.nativeImportCancellation={realIpcAbort:true,scratchRemoved:true,noNewJavaOrDecompilerProcess:true,noCompletedReport:true};
  assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'),originalDigest);report.checks.originalExecutableUnchanged=true;
  assert.equal((await tools.status('one')).running,null);report.checks.finalStateIdle=true;
}catch(error){report.errors.push({message:error.message,stack:error.stack});process.exitCode=1;}
finally{await tools.close();await writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
