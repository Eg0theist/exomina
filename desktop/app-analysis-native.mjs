// REA's isolated Ghidra adapter is the only native engine reachable here.
// Target files are data: never import, load, spawn, or otherwise execute them.
import {readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import reaPackage from 'rea-agents/package.json' with {type:'json'};
import {GhidraProvider} from 'rea-agents/dist/ghidra/GhidraProvider.js';
import {GHIDRA_INVENTORY_OPERATIONS,parseGhidraInventoryInput} from 'rea-agents/dist/ghidra/GhidraInventoryValues.js';
import {parseGhidraFunctionInput} from 'rea-agents/dist/ghidra/GhidraFunctionValues.js';
import {parseExecutableHeader} from 'rea-agents/dist/domain/binaryTarget.js';
import {SUPPORTED_GHIDRA_VERSION,ghidraReleaseLine} from 'rea-agents/dist/ghidra/GhidraReleasePolicy.js';
import {NATIVE_QUERIES,NATIVE_OPERATIONS,NATIVE_TARGET_SCOPE} from './app-analysis-contract.mjs';

export {NATIVE_QUERIES};
export const NATIVE_LIMITS=Object.freeze({analyzedFiles:4,entryBytes:64*1024*1024,inventoryEntries:10000,items:100,readBytes:4096,textBytes:1024*1024,observationBytes:2*1024*1024,outputBytes:12*1024*1024,defaultFunctions:3,startupTimeoutMs:330000,timeoutMs:600000});
const querySet=new Set(NATIVE_QUERIES),inventorySet=new Set(GHIDRA_INVENTORY_OPERATIONS);
const logger=Object.freeze({child(){return this;},debug(){},info(){},warn(){},error(){}});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeName=value=>typeof value==='string'&&value.length>0&&!value.includes('\0')&&!value.split(/[\\/]/).some(part=>part==='..')&&!path.isAbsolute(value)&&!value.includes(':');
const sensitive=value=>value.split(/[\\/]/).some(part=>/^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.codex|\.claude|\.gemini|\.kimi|\.grok|accounts|credentials|sessions|cookies|local storage|session storage)$/i.test(part)||/^\.env(?:\.|$)/i.test(part)||/^(?:\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|api-connections\.json|connections\.json|login data|keychain|credentials\.json|auth\.json|oauth.*\.json|token[s]?\.json)$/i.test(part)||/\.(?:pem|pfx|p12|key)$/i.test(part));
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const providerConfig=config=>({...(config?.ghidraInstallDir?{ghidraInstallDir:config.ghidraInstallDir}:{}),...(config?.ghidraJavaHome?{ghidraJavaHome:config.ghidraJavaHome}:{}),ghidraStartupTimeoutMs:NATIVE_LIMITS.startupTimeoutMs});
function validateConfiguration(config={}){
  if(config===null||typeof config!=='object'||Array.isArray(config))throw Error('Invalid native analysis configuration.');
  for(const name of ['ghidraInstallDir','ghidraJavaHome'])if(config[name]!==undefined&&(typeof config[name]!=='string'||!path.isAbsolute(config[name])||/[\0\r\n"%^!&|<>]/.test(config[name])))throw Error('Ghidra and JDK locations must be absolute directories without command-interpreter metacharacters.');
  return providerConfig(config);
}

/** Run this in the bundled Node worker; Electron must not load REA's native addon. */
export async function inspectNativeDependencies(config={}){
  const provider=new GhidraProvider(validateConfiguration(config),logger,process.env);
  try{
    return {...await provider.inspectAvailability(),requirements:{ghidraVersion:SUPPORTED_GHIDRA_VERSION,ghidraReleaseLine:ghidraReleaseLine(),java:'A 64-bit full JDK 21 or newer, within the Ghidra release\'s declared Java range.',host:'Windows x64, Windows 10 or later, local NTFS snapshots and private runtime.',targets:NATIVE_TARGET_SCOPE+' Managed EXEs and DLLs use the separate .NET inspections.',targetExecution:false,network:'Authenticated IPv4 loopback between the local Node worker and Ghidra only.'}};
  }finally{await closeProvider(provider);}
}

async function closeProvider(provider){
  const result=await provider.closeOwnedResources?.();
  if(result?.ok===false)throw result.error;
}

/** Reject mutation and oversized inputs before any Ghidra process is launched. */
export function validateNativeQuery(query){
  if(!query||typeof query!=='object'||Array.isArray(query)||!querySet.has(query.operation))throw Error('Choose a supported read-only native query.');
  if(query.args===undefined)query={...query,args:{}};
  if(!query.args||typeof query.args!=='object'||Array.isArray(query.args))throw Error('Native query arguments must be an object.');
  if(Buffer.byteLength(JSON.stringify(query.args))>16384)throw Error('Native query arguments exceed the 16 KiB limit.');
  for(const value of Object.values(query.args))if(typeof value==='string'&&(value.includes('\0')||value.length>4096))throw Error('Native query text exceeds its bounded length or contains NUL.');
  if(query.operation==='read_bytes'&&query.args.length!==undefined&&(!Number.isInteger(query.args.length)||query.args.length<1||query.args.length>NATIVE_LIMITS.readBytes))throw Error('Native byte reads are limited to 4096 bytes.');
  const parsed=(inventorySet.has(query.operation)?parseGhidraInventoryInput:parseGhidraFunctionInput)(query.operation,query.args);
  if(!parsed.ok)throw Error(`Invalid arguments for ${query.operation}: ${parsed.error.issues?.map(issue=>issue.message).join('; ')||parsed.error.message}`);
  const offset=query.offset??0,limit=query.limit??NATIVE_LIMITS.items;
  if(!Number.isSafeInteger(offset)||offset<0||offset>10000000||!Number.isInteger(limit)||limit<1||limit>NATIVE_LIMITS.items)throw Error('Native result offset must be nonnegative and limit must be between 1 and 100.');
  return {operation:query.operation,args:parsed.value,offset,limit};
}

function cancelled(signal){if(signal.aborted)throw signal.reason instanceof Error?signal.reason:Error('Native analysis was cancelled.');}
function errorText(error){return String(error?.message||error).slice(0,4000);}
function bounded(value,{offset=0,limit=NATIVE_LIMITS.items}={}){
  const truncations=[];
  let pagination;
  if(Array.isArray(value)){
    const total=value.length,next=Math.min(offset+limit,total);
    pagination={offset,limit,total,nextOffset:next<total?next:null};
    value=value.slice(offset,next);
  }else if(offset!==0)throw Error('Offsets apply only to inventory results returned as a list.');
  let budget=NATIVE_LIMITS.observationBytes,nodes=0;
  const visit=(item,location,depth)=>{
    if(++nodes>20000||depth>24||budget<=0){truncations.push({path:location,reason:'Evidence size or nesting limit reached.'});return null;}
    if(typeof item==='string'){
      const encoded=Buffer.from(item),bytes=Math.min(NATIVE_LIMITS.textBytes,Math.max(0,budget));
      if(encoded.length>bytes){truncations.push({path:location,originalBytes:encoded.length,returnedBytes:bytes});budget-=bytes;return new TextDecoder().decode(encoded.subarray(0,bytes));}
      budget-=encoded.length;return item;
    }
    if(item===null||typeof item!=='object'){budget-=16;return item;}
    if(Array.isArray(item)){
      const selected=item.slice(0,NATIVE_LIMITS.items);
      if(selected.length<item.length)truncations.push({path:location,originalItems:item.length,returnedItems:selected.length});
      return selected.map((child,index)=>visit(child,`${location}[${index}]`,depth+1));
    }
    const result=Object.create(null);
    for(const [key,child] of Object.entries(item)){
      budget-=Buffer.byteLength(key)+4;
      if(/^(?:token|bearer|session_token|access_token|refresh_token)$/i.test(key)){result[key]='[REDACTED]';continue;}
      result[key]=visit(child,location?`${location}.${key}`:key,depth+1);
    }
    return result;
  };
  const result=visit(value,'',0);
  return {result,...(pagination?{pagination}:{}),truncated:truncations.length>0||Boolean(pagination&&(pagination.offset>0||pagination.nextOffset!==null)),truncations:truncations.slice(0,100)};
}

async function snapshotEntry(root,entry){
  if(!entry||!safeName(entry.path)||sensitive(entry.path)||!Number.isInteger(entry.bytes)||entry.bytes<0||entry.bytes>NATIVE_LIMITS.entryBytes||typeof entry.sha256!=='string'||!/^([a-f0-9]{64})$/.test(entry.sha256))throw Error('Invalid bounded native snapshot inventory.');
  const file=path.join(root,entry.path),actual=await realpath(file);
  if(!inside(root,actual))throw Error('Native snapshot path leaves the selected copy.');
  const relative=path.relative(root,file).split(path.sep);let current=root;
  for(const part of relative){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('Native analysis cannot follow snapshot links or junctions.');}
  const metadata=await lstat(file);
  if(!metadata.isFile()||metadata.nlink>1||metadata.size!==entry.bytes||metadata.size>NATIVE_LIMITS.entryBytes)throw Error('Native snapshot file changed or exceeded its bounds.');
  const bytes=await readFile(file);
  if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error('Native snapshot content changed.');
  const parsed=parseExecutableHeader(bytes,process.arch,bytes.length);
  if(!parsed.ok)throw Error(`Exomina's current native integration could not read this executable header: ${parsed.error}`);
  return {bytes,target:{kind:'executable',path:file,sourcePath:file,sha256:entry.sha256,...parsed.value}};
}

/** Analyze immutable copies through REA's native path admission, owned job and bridge. */
export async function runNativeAnalysis(request,{signal,onProgress,providerFactory}={}){
  if(!request||!NATIVE_OPERATIONS.includes(request.operation))throw Error('Unknown native analysis operation.');
  const config=validateConfiguration(request.nativeConfig??{});
  const query=request.nativeQuery?validateNativeQuery(request.nativeQuery):null;
  if(request.operation==='native-query'&&!query)throw Error('Native query operation requires a read-only query.');
  if(request.procedure!==undefined&&(typeof request.procedure!=='string'||request.procedure.length<1||request.procedure.length>4096||request.procedure.includes('\0')))throw Error('Specify a function name or hexadecimal address of at most 4096 characters.');
  if(request.nativeFile!==undefined&&(!safeName(request.nativeFile)||sensitive(request.nativeFile)))throw Error('Specify a safe relative native snapshot file.');
  if(!Array.isArray(request.files)||request.files.length>NATIVE_LIMITS.inventoryEntries)throw Error('Invalid bounded native snapshot inventory.');
  const root=await realpath(request.snapshot),rootMetadata=await lstat(request.snapshot);
  if(rootMetadata.isSymbolicLink()||!rootMetadata.isDirectory())throw Error('Native snapshot root must be a real directory.');
  const selected=request.nativeFile?request.files.filter(entry=>entry?.path===request.nativeFile):request.files.filter(entry=>/\.exe$/i.test(entry?.path??''));
  if(request.nativeFile&&selected.length!==1)throw Error('The requested native file is absent from the selected snapshot.');
  if(query&&selected.length!==1)throw Error('Choose one native executable file for this query.');
  const provider=providerFactory?providerFactory(config,logger):new GhidraProvider(config,logger,process.env);
  const controller=new AbortController(),onAbort=()=>controller.abort(Error('Native analysis was cancelled.'));
  if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(Error('Native analysis exceeded its ten-minute limit.')),NATIVE_LIMITS.timeoutMs);timer.unref?.();
  const files=[],failures=[],limitations=['Static native analysis only: the selected executable is never run. '+NATIVE_TARGET_SCOPE, 'Ghidra pseudocode approximates behavior; it is not the original C, C++, Rust or Go source. Symbols may be stripped, computed call targets may remain unknown, and packed programs may require a separately selected unpacked copy.'];
  if(selected.length>NATIVE_LIMITS.analyzedFiles)limitations.push(`Only the first ${NATIVE_LIMITS.analyzedFiles} executable files were analyzed; choose a relative file for a focused query.`);
  let analyzedFiles=0,outputBytes=0;
  try{
    cancelled(controller.signal);
    const availability=await provider.inspectAvailability({signal:controller.signal});
    cancelled(controller.signal);
    if(availability.status!=='available')throw Error(`Native analysis unavailable: ${availability.reason||availability.code}`);
    for(const entry of selected.slice(0,NATIVE_LIMITS.analyzedFiles)){
      cancelled(controller.signal);let client;
      try{
        const {target}=await snapshotEntry(root,entry);
        if(target.managed)throw Error('Use Exomina\'s separate .NET inspections for this managed target.');
        if(target.format!=='pe'||target.executableRole!=='application'||!['x86','x86_64'].includes(target.architecture))throw Error(NATIVE_TARGET_SCOPE);
        const supported=provider.inspectTargetSupport(target);
        if(supported.status!=='supported')throw Error((target.managed?'Use Exomina\'s separate .NET inspections for this managed target. ':NATIVE_TARGET_SCOPE+' ')+(supported.reason?`REA target check: ${supported.reason}`:'This target is outside the current native workflow.'));
        analyzedFiles++;
        const profile=await provider.resolveAnalysisProfile(target,{signal:controller.signal});
        if(!profile.ok)throw profile.error;
        if(!profile.value?.profile)throw Error('REA did not resolve an analysis profile for the executable.');
        client=provider.createClient(target,profile.value.profile,{runId:randomUUID()});
        const observations=[],fileLimitations=[];
        const execute=async(operation,args={},page={})=>{
          cancelled(controller.signal);onProgress?.({stage:operation==='health'?'import':'query',file:entry.path,operation});
          const response=await client.execute(operation,args,{signal:controller.signal});
          cancelled(controller.signal);
          if(!response.ok)throw response.error;
          const projected=bounded(response.value.result,page);
          const observation={operation,...projected,provider:response.value.provider,analysisProfileDigest:response.value.analysisProfile?.digest??profile.value.profile.digest};
          const size=Buffer.byteLength(JSON.stringify(observation));
          if(outputBytes+size>NATIVE_LIMITS.outputBytes)throw Error('The 12 MiB native report evidence limit was reached.');
          outputBytes+=size;observations.push(observation);fileLimitations.push(...(response.value.limitations??[]));
          return response.value.result;
        };
        await execute('health');
        if(query)await execute(query.operation,query.args,query);
        else if(request.operation==='native'){
          for(const operation of ['list_documents','list_segments','list_procedures','list_strings','list_names'])await execute(operation);
        }else{
          const procedures=await execute('list_procedures');
          const chosen=request.procedure?[request.procedure]:procedures.filter(item=>!item.procedure?.external&&!item.procedure?.thunk).slice(0,NATIVE_LIMITS.defaultFunctions).map(item=>item.address);
          for(const procedure of chosen)await execute('analyze_function',{procedure});
          if(!request.procedure)fileLimitations.push(`Detailed function evidence is a sample of at most ${NATIVE_LIMITS.defaultFunctions} functions. Use a native query and a function address to investigate any listed function.`);
        }
        files.push({path:entry.path,bytes:entry.bytes,sha256:entry.sha256,result:{target:{format:target.format,architecture:target.architecture,availableArchitectures:target.availableArchitectures,executableRole:target.executableRole,managed:target.managed},observations,limitations:[...new Set(fileLimitations)]}});
      }catch(error){
        cancelled(controller.signal);
        if(failures.length<100)failures.push({path:entry.path,error:errorText(error),code:error?._tag??error?.code??null,...(error?.diagnostics?{diagnostics:bounded(error.diagnostics).result}:{})});
      }finally{
        if(client){onProgress?.({stage:'cleanup',file:entry.path});await client.close();}
      }
    }
    cancelled(controller.signal);
    if(selected.length===0)limitations.push('No .exe application is present in the bounded snapshot. Select a native Windows x86/x64 EXE for the current Exomina workflow.');
    return {engine:'REA',engineVersion:reaPackage.version,operation:request.operation,analyzedFiles,files,failures,limitations,limits:NATIVE_LIMITS};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);await closeProvider(provider);}
}
