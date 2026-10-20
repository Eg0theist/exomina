// Full official entrypoint probe, using Exomina's real launch environment and
// an empty test profile. Native commands and network operations are synthetic.
import cp from 'node:child_process';
import util from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const mode=process.argv[2];
if(!['--version','--acp'].includes(mode))throw Error('Unsupported synthetic probe mode.');
const root=fileURLToPath(new URL('../../',import.meta.url));
const testRoot=path.join(root,'.verification');
const base=path.resolve(process.argv[3]);
if(!base.startsWith(testRoot+path.sep))throw Error('Synthetic profile must be inside the test directory.');
fs.mkdirSync(base,{recursive:true});
const safeEnv={};
for(const key of ['SystemRoot','SYSTEMROOT','windir','WINDIR','PATH','Path','PATHEXT','ComSpec','COMSPEC','ProgramFiles','PROGRAMFILES','ProgramFiles(x86)','PROCESSOR_ARCHITEW6432'])if(process.env[key])safeEnv[key]=process.env[key];
const calls=[];
const record=(name,args)=>calls.push({name,command:String(args[0]),windowsHide:(Array.isArray(args[1])?args[2]:args[1])?.windowsHide===true});
const stubExec=(...args)=>{
  record('exec',args);
  const callback=args.find(value=>typeof value==='function');
  if(callback)queueMicrotask(()=>callback(null,'REG_SZ synthetic-machine-id',''));
  return {on(){return this},once(){return this},kill(){}};
};
stubExec[util.promisify.custom]=async(...args)=>{record('execAsync',args);return {stdout:'REG_SZ synthetic-machine-id',stderr:''};};
cp.exec=stubExec;
cp.execSync=(...args)=>{
  record('execSync',args);
  if(args[0]==='chcp')return Buffer.from('Active code page: 65001');
  throw Error('Native process blocked by synthetic startup probe.');
};
cp.spawnSync=(...args)=>{
  record('spawnSync',args);
  // Return synthetic ACL results only for this test profile and its ancestry.
  // Production permission checks and ACLs are never changed by this probe.
  const argv=args[1];
  const index=Array.isArray(argv)?argv.indexOf('-EncodedCommand'):-1;
  if(index>=0){
    const script=Buffer.from(argv[index+1],'base64').toString('utf16le');
    const array=script.match(/\$paths = @\(([^\r\n]*)\)/)?.[1];
    const paths=[...(array||'').matchAll(/'((?:[^']|'')*)'/g)].map(match=>match[1].replace(/''/g,"'"));
    if(paths.length&&paths.every(item=>item.toLowerCase().startsWith(base.toLowerCase()+path.sep)||base.toLowerCase().startsWith(item.toLowerCase()+path.sep)||item.toLowerCase()===base.toLowerCase()))return {status:0,stdout:paths.map(item=>'PATH:'+item).join('\n'),stderr:''};
    throw Error('Synthetic ACL paths rejected: '+JSON.stringify(paths));
  }
  throw Error('Native process blocked by synthetic startup probe.');
};
for(const name of ['spawn','execFile','execFileSync','fork'])cp[name]=(...args)=>{record(name,args);throw Error('Native process blocked by synthetic startup probe.');};
globalThis.fetch=async()=>{throw Error('Network blocked by synthetic startup probe.');};
for(const module of [http,https])for(const name of ['request','get'])module[name]=()=>{throw Error('Network blocked by synthetic startup probe.');};
os.homedir=()=>path.join(base,'gemini-home');
syncBuiltinESMExports();

const {subscriptionEnvironment}=await import(new URL('../../desktop/providers.mjs',import.meta.url));
const {AcpProvider}=await import(new URL('../../desktop/provider-acp.mjs',import.meta.url));
let launch;
const manager={dataDir:base,workspace:base,toolDefinitions:[],prepare:async()=>{},environment:id=>subscriptionEnvironment(id,base,safeEnv),spawnImpl:(command,args,options)=>{launch={command,args,options};return {once(){return this}};}};
await new AcpProvider(manager,'gemini-cli').launch({args:[mode]});
if(mode==='--acp'){
  // A selected OAuth method causes the official CLI to start its interactive
  // sign-in before ACP dispatch. This synthetic signed-out profile has no
  // credentials: clear only its selection, retaining enforced subscription
  // auth. Production settings and profiles are never accessed or changed.
  const settingsPath=launch.options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
  delete settings.security.auth.selectedType;
  fs.writeFileSync(settingsPath,JSON.stringify(settings));
}
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,launch.options.env,{NO_COLOR:'1',CI:'true'});
process.chdir(base);
const scriptIndex=launch.args[0]==='--require'?2:0;
if(scriptIndex&&launch.args[1]!==path.join(root,'desktop','provider-diagnostics.cjs'))throw Error('Unexpected synthetic provider preload.');
const officialArgs=launch.args.slice(scriptIndex);
// Native Node strips its own --require option before dispatching the CLI.
// Reproduce that here while loading the real guard over the synthetic stubs.
process.argv=[process.execPath,...officialArgs];
if(scriptIndex)createRequire(import.meta.url)(launch.args[1]);

let stdout='',stderr='',finished=false;
const nativeWrite=process.stdout.write.bind(process.stdout);
const chunkText=chunk=>typeof chunk==='string'?chunk:Buffer.from(chunk).toString('utf8');
process.stdout.write=(chunk,encodingOrCb,cb)=>{stdout+=chunkText(chunk);(typeof encodingOrCb==='function'?encodingOrCb:cb)?.();return true;};
process.stderr.write=(chunk,encodingOrCb,cb)=>{stderr+=chunkText(chunk);(typeof encodingOrCb==='function'?encodingOrCb:cb)?.();return true;};
const nativeExit=process.exit.bind(process);
const finish=code=>{
  if(finished)return;
  finished=true;
  const response=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).find(item=>item.id===1);
  nativeWrite(JSON.stringify({mode,code:code||0,version:mode==='--version'?stdout.trim():undefined,response,calls,machineGuidCalls:calls.filter(call=>/MachineGuid/i.test(call.command)),securityWarning:/Skipping system (settings|defaults)/.test(stderr),securityMessages:stderr.split(/\r?\n/).filter(line=>line.startsWith('Security Warning')),startupMessages:!response&&mode==='--acp'?{stdout:stdout.replace(/https?:\/\/\S+/g,'[synthetic auth URL]'),stderr}:undefined})+'\n');
};
process.exit=code=>{finish(code);nativeExit(code||0);};
process.on('beforeExit',()=>finish(0));
process.on('uncaughtException',error=>{stderr+=error.stack;finish(1);nativeExit(1);});
const timeout=setTimeout(()=>{stderr+='Synthetic startup timed out';finish(1);nativeExit(1);},15000);
timeout.unref();
await import(pathToFileURL(officialArgs[0]));
