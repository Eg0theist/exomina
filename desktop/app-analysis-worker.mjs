// Fixed REA parsers and the explicit Ghidra runtime adapter inspect target files as data.
// Do not import REA's CLI, composition root, MCP catalog or runtime providers.
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {analyzeJavaScriptStaticSource} from 'rea-agents/dist/domain/javascript/javascriptStaticAnalysis.js';
import {inspectManagedArtifactBytes} from 'rea-agents/dist/dotnet/ManagedArtifactInspector.js';
import {inspectManagedMembersBytes} from 'rea-agents/dist/dotnet/ManagedMemberInspector.js';
import {inspectManagedNativeBoundariesBytes} from 'rea-agents/dist/dotnet/ManagedNativeBoundaryInspector.js';
import {AsarArtifactReader} from 'rea-agents/dist/artifacts/AsarArtifactReader.js';

const OPERATIONS=new Set(['javascript','managed','managed-members','managed-native','inventory','native','native-functions','native-query']);
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const safeName=value=>typeof value==='string'&&!value.includes('\0')&&!value.split(/[\\/]/).some(part=>part==='..')&&!path.isAbsolute(value)&&!value.includes(':');
const sensitive=value=>value.split(/[\\/]/).some(part=>/^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.config|\.codex|\.claude|\.gemini|\.kimi|\.grok|accounts|credentials|sessions|cookies|local storage|session storage)$/i.test(part)||/^\.env(?:\.|$)/i.test(part)||/^(?:\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|api-connections\.json|connections\.json|login data|keychain|credentials\.json|auth\.json|oauth.*\.json|token[s]?\.json)$/i.test(part)||/\.(?:pem|pfx|p12|key)$/i.test(part));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const LIMITS={analyzedFiles:500,textBytes:64*1024*1024,javascriptFileBytes:4*1024*1024,outputBytes:12*1024*1024,entryBytes:64*1024*1024,archiveEntries:10000};

async function main(){
  const [, , operation,requestFile]=process.argv;
  if(operation==='native-dependencies'){
    const {inspectNativeDependencies}=await import('./app-analysis-native.mjs');
    process.stdout.write(JSON.stringify(inspectNativeDependencies(JSON.parse(requestFile||'{}'))));return;
  }
  if(!OPERATIONS.has(operation)||!requestFile)throw Error('Unknown static analysis operation.');
  const request=JSON.parse(await readFile(requestFile,'utf8'));
  if(operation.startsWith('native')){
    const controller=new AbortController();
    const cancel=message=>{if(message?.type==='cancel')controller.abort(Error('Application analysis cancelled.'));};
    process.on('message',cancel);
    try{const {runNativeAnalysis}=await import('./app-analysis-native.mjs');const result=await runNativeAnalysis({...request,operation},{signal:controller.signal,onProgress:progress=>{if(process.connected)process.send({type:'progress',phase:progress.stage==='cleanup'?'Cleaning up Ghidra':progress.stage==='import'?'Importing executable in Ghidra':`Ghidra: ${progress.operation}`},()=>{});}});await writeFile(request.output,JSON.stringify(result),'utf8');process.stdout.write(JSON.stringify({completed:true,analyzedFiles:result.analyzedFiles,evidenceFiles:result.files.length,failures:result.failures.length}));}
    finally{process.off('message',cancel);if(process.connected)process.disconnect();}return;
  }
  const root=await realpath(request.snapshot);
  if(!Array.isArray(request.files)||request.files.length>10000)throw Error('Invalid bounded snapshot inventory.');
  const files=[],failures=[],limitations=['Static analysis only. Target code is never loaded or executed. This report does not include dynamic behavior or native disassembly/decompilation; use a native operation for supported executable files.'];
  let textBytes=0,outputBytes=0,analyzed=0;
  const append=(name,bytes,result)=>{
    const record={path:name,bytes:bytes.length,sha256:digest(bytes),result};
    const length=Buffer.byteLength(JSON.stringify(record));
    if(length>1024*1024){limitations.push(`Result omitted for ${name}: exceeds the 1 MiB per-file evidence limit.`);return;}
    if(outputBytes+length>LIMITS.outputBytes){limitations.push('The 12 MiB report evidence limit was reached; later files were omitted.');return;}
    outputBytes+=length;files.push(record);
  };
  const analyze=(name,bytes)=>{
    if(analyzed>=LIMITS.analyzedFiles){if(!limitations.includes('The 500-file analysis limit was reached.'))limitations.push('The 500-file analysis limit was reached.');return;}
    if(operation==='javascript'){
      if(!/\.(?:js|cjs|mjs|jsx|ts|tsx)$/i.test(name))return;
      if(bytes.length>LIMITS.javascriptFileBytes||textBytes+bytes.length>LIMITS.textBytes){limitations.push(`JavaScript omitted for ${name}: bounded text parsing limit.`);return;}
      const source=new TextDecoder('utf8',{fatal:true}).decode(bytes);textBytes+=bytes.length;analyzed++;
      append(name,bytes,analyzeJavaScriptStaticSource(source));return;
    }
    if(operation.startsWith('managed')){
      if(!/\.(?:dll|exe)$/i.test(name))return;
      analyzed++;const target={path:name,sha256:digest(bytes)};
      const inspector=operation==='managed'?inspectManagedArtifactBytes:operation==='managed-members'?inspectManagedMembersBytes:inspectManagedNativeBoundariesBytes;
      append(name,bytes,inspector(bytes,target));
    }
  };
  for(const entry of request.files){
    if(!entry||!safeName(entry.path)||sensitive(entry.path))throw Error('Unsafe snapshot inventory path.');
    const file=path.join(root,entry.path);const actual=await realpath(file);const metadata=await lstat(file);
    if(!inside(root,actual)||metadata.isSymbolicLink()||!metadata.isFile()||metadata.nlink>1||metadata.size>LIMITS.entryBytes)throw Error('Snapshot file changed or exceeded its bounds.');
    // Inventory needs only snapshot identities already verified by the host.
    if(operation==='inventory')continue;
    try{
      if(operation==='javascript'&&/\.asar$/i.test(entry.path)){
        const inputArchive=await readFile(file);if(inputArchive.length!==entry.bytes||digest(inputArchive)!==entry.sha256)throw Error('ASAR snapshot content changed.');
        const reader=new AsarArtifactReader(file);let entries=0,archiveBytes=0,omitted=0;
        try{for await(const member of reader.entries()){
          if(++entries>LIMITS.archiveEntries){limitations.push(`ASAR inventory limit reached in ${entry.path}.`);break;}
          if(member.kind!=='file'||member.unpacked||!safeName(member.path)||sensitive(member.path)){if(member.kind!=='directory')omitted++;continue;}
          if(!/\.(?:js|cjs|mjs|jsx|ts|tsx)$/i.test(member.path))continue;
          if(member.declaredSize>LIMITS.javascriptFileBytes||archiveBytes+member.declaredSize>LIMITS.textBytes){limitations.push(`ASAR text limit excludes ${member.path}.`);continue;}
          const chunks=[];let size=0;const stream=await reader.open(member);
          for await(const chunk of stream){size+=chunk.length;if(size>LIMITS.javascriptFileBytes)throw Error('ASAR member exceeded bounded size.');chunks.push(chunk);}
          archiveBytes+=size;const bytes=Buffer.concat(chunks,size);
          if(member.declaredSha256&&digest(bytes)!==member.declaredSha256)throw Error('ASAR member integrity mismatch.');
          analyze(`${entry.path}/${member.path}`,bytes);
        }}finally{await reader.close();}
        if(omitted)limitations.push(`${omitted} linked, sensitive or external unpacked ASAR members were omitted from ${entry.path}.`);
        continue;
      }
      if(operation==='javascript'&&!/\.(?:js|cjs|mjs|jsx|ts|tsx)$/i.test(entry.path))continue;
      if(operation.startsWith('managed')&&!/\.(?:dll|exe)$/i.test(entry.path))continue;
      const bytes=await readFile(file);if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error('Snapshot content changed.');
      analyze(entry.path,bytes);
    }catch(error){if(failures.length<100)failures.push({path:entry.path,error:String(error.message||error).slice(0,1000)});}
  }
  const result={engine:'REA',engineVersion:'6.1.0',operation,analyzedFiles:analyzed,files,failures,limitations:[...new Set(limitations)],limits:LIMITS};
  await writeFile(request.output,JSON.stringify(result),'utf8');
  process.stdout.write(JSON.stringify({completed:true,analyzedFiles:analyzed,evidenceFiles:files.length,failures:failures.length}));
}
// The worker is a fixed entry point, never a module imported by target code.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(String(error.message||error).slice(0,4000));process.exitCode=1;});
