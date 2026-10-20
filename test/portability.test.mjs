import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {readFile,mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {normalizedPath,pathWithin,pathsEqual} from '../desktop/path-policy.mjs';
import {appPaths} from '../desktop/app-paths.mjs';
import {codexRuntimePaths,bundledGrokPaths} from '../desktop/runtime-targets.mjs';
import {WorkspaceTools,workspaceShell} from '../desktop/workspace-tools.mjs';
import {WindowsVault} from '../desktop/vault.mjs';
import {privateGate} from '../desktop/private-gate.mjs';
import {crossPlatformConfig} from '../scripts/cross-platform-config.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
test('Unix private/workspace boundaries do not merge distinct case-sensitive directories',()=>{
  for(const platform of ['linux','darwin']){
    const options={platform,pathApi:path.posix};
    assert.equal(pathsEqual('/home/test/Private','/home/test/private',options),false);
    assert.equal(pathWithin('/home/test/Workspace','/home/test/workspace/notes.txt',options),false);
    assert.equal(pathWithin('/home/test/Workspace','/home/test/Workspace/notes.txt',options),true);
    assert.equal(pathWithin('/home/test/Workspace','/home/test/Workspace-other/notes.txt',options),false);
    assert.equal(pathWithin('/home/test/Workspace','/home/test/Workspace/../Private/key',options),false);
    assert.equal(pathWithin('/','/home/test',options),true);
  }
  const win={platform:'win32',pathApi:path.win32};
  assert.equal(pathsEqual('C:\\Test\\Private','c:\\test\\private',win),true);
  assert.equal(pathWithin('C:\\Test\\Workspace','c:\\test\\WORKSPACE\\note',win),true);
  assert.equal(pathWithin('C:\\Test\\Workspace','c:\\test\\workspace-other\\note',win),false);
  assert.equal(normalizedPath('/home/test/A',{platform:'linux',pathApi:path.posix}),'/home/test/A');
});

test('packaged macOS/Linux locations use OS app data without LOCALAPPDATA',()=>{
  for(const [platform,appData] of [['darwin','/synthetic/macos/Library/Application Support'],['linux','/home/test/.config']]){
    const options={packaged:true,root:'/opt/exomina',platform,appData,documents:'/home/test/Documents',env:{},pathApi:path.posix};
    assert.deepEqual(appPaths(options),{dataDir:appData+'/Exomina/Private/data',accountsDir:appData+'/Exomina/Private/accounts',workspace:'/home/test/Documents/Exomina/Workspace'});
    assert.equal(appPaths({...options,env:{EXOMINA_DATA_DIR:'/tmp/synthetic/profile'}}).dataDir,'/tmp/synthetic/profile');
    assert.throws(()=>appPaths({...options,appData:undefined}),/could not locate/);
  }
});

test('Codex candidates match official native target packages for six platform/architecture pairs',()=>{
  for(const [platform,arch,target] of [
    ['darwin','arm64','aarch64-apple-darwin'],['darwin','x64','x86_64-apple-darwin'],
    ['linux','arm64','aarch64-unknown-linux-musl'],['linux','x64','x86_64-unknown-linux-musl'],
    ['win32','arm64','aarch64-pc-windows-msvc'],['win32','x64','x86_64-pc-windows-msvc'],
  ]){
    const p=platform==='win32'?path.win32:path.posix;
    const app=platform==='win32'?'C:\\app':'/opt/app';
    const binary=platform==='win32'?'codex.exe':'codex';
    const candidates=codexRuntimePaths(app,{platform,arch,pathApi:p});
    assert.equal(candidates[0],p.join(app,'node_modules','@openai',`codex-${platform}-${arch}`,'vendor',target,'bin',binary));
    assert.equal(candidates[1],p.join(app,'node_modules','@openai',`codex-${platform}-${arch}`,'vendor',target,'codex',binary));
  }
  assert.deepEqual(codexRuntimePaths('/app',{platform:'linux',arch:'ia32',pathApi:path.posix}),[]);
  assert.deepEqual(bundledGrokPaths('/app',{platform:'linux',arch:'arm64',pathApi:path.posix}),['/app/vendor/grok/grok']);
});

test('Unix terminal approval precedes spawn and executes the approved command as one argument',async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'exomina-portability-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const workspace=path.join(dataDir,'workspace');await mkdir(workspace);
  const canonicalWorkspace=await realpath(workspace);
  const command="printf '%s\\n' 'synthetic $(literal)'; printf '世界'";
  for(const platform of ['linux','darwin']){
    let approved=false,spawned=0,detail='';
    const tools=new WorkspaceTools({dataDir,getSettings:()=>({workspace}),platform,
      approve:async request=>{detail=request.detail;approved=true;return true;},
      spawnImpl:(exe,args,options)=>{
        assert.equal(approved,true);spawned++;
        assert.equal(exe,'/bin/sh');assert.deepEqual(args,['-c',command]);
        assert.equal(options.shell,false);assert.equal(options.detached,true);assert.equal(options.cwd,canonicalWorkspace);
        const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
        child.kill=()=>{};queueMicrotask(()=>{child.stdout.write('synthetic 世界');child.emit('close',0,null);});return child;
      }});
    const result=JSON.parse((await tools.call('workspace_shell',{command,timeoutSeconds:1},'synthetic')).content[0].text);
    assert.equal(result.output,'synthetic 世界');assert.equal(result.exitCode,0);
    assert.equal(spawned,1);assert.ok(detail.includes(command));assert.ok(detail.includes('POSIX shell'));assert.ok(detail.includes(canonicalWorkspace));
    const denied=new WorkspaceTools({dataDir,getSettings:()=>({workspace}),platform,approve:async()=>false,spawnImpl:()=>{throw Error('must not spawn');}});
    await assert.rejects(denied.call('workspace_shell',{command},'denied'),/declined/);
  }
  assert.throws(()=>workspaceShell('unknown','echo synthetic'),/not available/);
  assert.equal(workspaceShell('win32','Write-Output synthetic',{systemRoot:'C:\\Windows'}).executable,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('Unix Stop targets only the terminal process group created by this instance',()=>{
  const calls=[];const child={pid:32145,exitCode:null,signalCode:null,kill:()=>calls.push('fallback')};
  const tools=new WorkspaceTools({dataDir:'unused',getSettings:()=>({}),approve:async()=>true,platform:'linux',killImpl:(pid,signal)=>calls.push([pid,signal])});
  tools.stop(child);assert.deepEqual(calls,[[-32145,'SIGKILL']]);
  // Exiting the leader does not mean its background descendants released pipes.
  child.exitCode=0;tools.stop(child);assert.deepEqual(calls,[[-32145,'SIGKILL'],[-32145,'SIGKILL']]);
});

test('Unix timeout completes even when an exited shell leader leaves descendant pipes open',{timeout:3000},async t=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'exomina-portability-timeout-'));
  const workspace=path.join(dataDir,'workspace');await mkdir(workspace);
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let child,terminated=false;
  const tools=new WorkspaceTools({dataDir,getSettings:()=>({workspace}),approve:async()=>true,platform:'linux',
    spawnImpl:()=>{child=new EventEmitter();Object.assign(child,{pid:32146,exitCode:0,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{throw Error('only the leader was signaled');}});queueMicrotask(()=>child.emit('exit',0,null));return child;},
    killImpl:(pid,signal)=>{assert.equal(pid,-32146);assert.equal(signal,'SIGKILL');terminated=true;queueMicrotask(()=>child.emit('close',0,null));}});
  t.after(()=>tools.close());
  const result=JSON.parse((await tools.call('workspace_shell',{command:'sleep 30 &',timeoutSeconds:1},'synthetic-background')).content[0].text);
  assert.equal(terminated,true);assert.equal(result.timedOut,true);assert.equal(tools.processes.size,0);
});

test('unimplemented Unix vault fails closed before spawning or unlocking account stores',async()=>{
  for(const platform of ['linux','darwin']){
    let spawned=0;const vault=new WindowsVault({platform,spawnImpl:()=>{spawned++;throw Error('must not spawn');}});
    const gate=privateGate({verify:()=>vault.preflight('/tmp/synthetic-private')});
    await assert.rejects(gate(),/Windows EFS/);await assert.rejects(gate(),/Windows EFS/);
    assert.equal(spawned,0);vault.close();
  }
});

test('native package preparation omits Windows payloads and release commands refuse cross-host installers',async()=>{
  for(const platform of ['darwin','linux']){
    const config=crossPlatformConfig(platform,{arch:'x64'});
    assert.equal(config.electronDist,null);assert.equal(config.nsis,null);
    assert.ok(config.files.includes('!vendor/grok/*.exe'));
    const formats=(platform==='darwin'?config.mac:config.linux).target;
    assert.deepEqual(formats.flatMap(item=>item.arch),['x64','x64']);
  }
  const other=process.platform==='darwin'?'linux':'darwin';
  let failure;try{await promisify(execFile)(process.execPath,['scripts/package-cross-platform.mjs',other,'--preflight-only'],{cwd:root,timeout:5000});}catch(error){failure=error;}
  assert.equal(failure?.code,2);assert.match(failure.stderr,/No qualified installer was produced/);assert.match(failure.stderr,/matching operating system and architecture/);
  const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
  assert.equal(metadata.dependencies['@xai-official/grok-win32-x64'],undefined);
  assert.equal(metadata.optionalDependencies['@xai-official/grok-win32-x64'],'1.0.46');
  assert.equal(lock.packages['node_modules/@xai-official/grok-win32-x64'].optional,true);
});
