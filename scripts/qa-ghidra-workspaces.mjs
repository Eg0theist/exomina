// Real GhidraMCP core and Ghidra 12.1.4; synthetic binary never executed.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtimeRoot=path.resolve(process.env.EXOMINA_QA_RUNTIME_ROOT||root),output=path.resolve(process.argv[2]||'../Workspace/ghidra-sidebar-20261011/ghidra-real');
const {AppAnalysis}=await import(pathToFileURL(path.join(runtimeRoot,'desktop/app-analysis.mjs'))),{WorkspaceTools}=await import(pathToFileURL(path.join(runtimeRoot,'desktop/workspace-tools.mjs'))),{GhidraWorkspaces}=await import(pathToFileURL(path.join(runtimeRoot,'desktop/ghidra-workspaces.mjs')));
const base=path.resolve(root,'../Workspace/rea-native-verification'),profile=path.join(output,'synthetic-data'),workspace=path.join(output,'workspace');await mkdir(profile,{recursive:true});await mkdir(workspace,{recursive:true});
const fixture=path.join(workspace,'fixture.exe');await copyFile(path.join(base,'rea-native-fixture.exe'),fixture);
const hash=buffer=>createHash('sha256').update(buffer).digest('hex'),original=hash(await readFile(fixture)),chat={id:'synthetic-ghidra'},approvals=[];let denyEdit=false;
const approve=async request=>{approvals.push({tool:request.action?.tool,kind:request.action?.kind,requireConfirmation:request.requireConfirmation});return !(denyEdit&&request.action?.kind==='write');};
const workspaceTools=new WorkspaceTools({dataDir:profile,privateDirs:[],getSettings:()=>({workspace}),approve});
const analysis=new AppAnalysis({dataDir:profile,workspaceTools,approve,getChat:id=>id===chat.id?chat:null});
const tools=new GhidraWorkspaces({dataDir:profile,analysis,approve,getChat:id=>id===chat.id?chat:null,runtimeRoot});
const unpack=result=>JSON.parse(result.content[0].text),report={passed:false,checks:{},approvals,errors:[],scope:'Owned Ghidra process and GhidraMCP core, synthetic x64/x86 EXEs, no app accounts or provider requests'};
try{
 await analysis.configureNative({ghidraPath:path.join(base,'ghidra/ghidra_12.1.4_PUBLIC'),javaPath:path.join(base,'jdk/jdk-21.0.12.1+1')});await analysis.select(chat.id,fixture);
 const ready=await tools.start(chat.id,{userAction:true});assert.equal(ready.state,'connected');report.checks.realCoreStarted=true;report.program=ready.program;console.log('Ghidra workspace ready');
 const functions=unpack(await tools.call('ghidra_query',{operation:'functions',arguments:{limit:2}},chat.id));assert.ok(functions.result.items.length>0);const address=functions.result.items[0].address||functions.result.items[0].entry;report.function=functions.result.items[0];assert.ok(address);report.checks.realFunctionsAndPagination=true;
 const decompiled=unpack(await tools.call('ghidra_query',{operation:'decompile',arguments:{address}},chat.id));assert.ok(decompiled.result);report.checks.realDecompilation=true;
 await assert.rejects(tools.call('ghidra_edit',{operation:'rename_function',arguments:{address,new_name:'exomina_verified_function'}},chat.id),/Enable project edits/);report.checks.editsOffByDefault=true;
 await tools.enableEditing(chat.id,true);denyEdit=true;await assert.rejects(tools.call('ghidra_edit',{operation:'rename_function',arguments:{address,new_name:'exomina_verified_function'}},chat.id),/declined/);assert.ok(!JSON.stringify(unpack(await tools.call('ghidra_query',{operation:'function',arguments:{address}},chat.id))).includes('exomina_verified_function'));report.checks.declinedEditDoesNotMutate=true;
 denyEdit=false;const edited=unpack(await tools.call('ghidra_edit',{operation:'rename_function',arguments:{address,new_name:'exomina_verified_function'}},chat.id));assert.ok(edited.checkpoint.endsWith('.gzf'));assert.ok(JSON.stringify(unpack(await tools.call('ghidra_query',{operation:'function',arguments:{address}},chat.id))).includes('exomina_verified_function'));report.checks.approvedRenameAndCheckpoint=true;
 const comment=unpack(await tools.call('ghidra_edit',{operation:'set_comment',arguments:{address,comment:'Exomina synthetic verification',view:'decompiler'}},chat.id));assert.ok(comment.checkpoint);report.checks.approvedComment=true;
 report.project=tools.status(chat.id).project;await tools.stop(chat.id);assert.equal(tools.status(chat.id).state,'stopped');console.log('Ghidra saved and stopped');
 await tools.start(chat.id,{userAction:true});assert.ok(JSON.stringify(unpack(await tools.call('ghidra_query',{operation:'function',arguments:{address}},chat.id))).includes('exomina_verified_function'));report.checks.editsSurviveRestart=true;
 assert.equal(hash(await readFile(fixture)),original);report.checks.originalBinaryUnchanged=true;
 assert.ok(approvals.filter(x=>x.kind==='write').every(x=>x.requireConfirmation));report.checks.everyEditRequestsExplicitApproval=true;
 await tools.stop(chat.id);const fixture32=path.join(workspace,'fixture-x86.exe');await copyFile(path.join(base,'rea-native-fixture-x86.exe'),fixture32);await analysis.select(chat.id,fixture32);const ready32=await tools.start(chat.id,{userAction:true});report.program32=ready32.program;assert.equal(ready32.state,'connected');report.checks.x86AlsoStarts=true;
 report.passed=true;
}catch(error){report.errors.push(error.stack);throw error;}finally{await tools.close();await analysis.close();await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
