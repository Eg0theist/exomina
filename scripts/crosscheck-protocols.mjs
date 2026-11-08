import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exploreProtocol,PROTOCOL_MODELS} from '../desktop/protocol-explorer.mjs';

const execute=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const TLC_PIN=Object.freeze({
  release:'v1.7.4',commit:'5a47802',tlcVersion:'2.19 of 08 August 2024',
  source:'https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4',
  asset:'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar',
  sha1:'bee4a54f3ee3d4afc347c3240ec2d9e93b075104',
  sha256:'936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88',
});
export const CASES=Object.freeze([
  {model:'delivery',module:'Delivery',fault:null},
  {model:'installation',module:'Installation',fault:null},
  {model:'delivery',module:'Delivery',fault:'skip-final-authorization',flag:'badAuthorization'},
  {model:'delivery',module:'Delivery',fault:'replay-unknown',flag:'replayedUnknown'},
  {model:'installation',module:'Installation',fault:'trust-staged-mark',flag:'accepted'},
]);
const hash=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
export function parseTlcOutput(output,exitCode){
  const text=String(output).replace(/\u001b\[[\d;]*m/g,''),counts=/([\d,]+) states generated,\s*([\d,]+) distinct states found/.exec(text);
  const exhausted=exitCode===0&&/Model checking completed\. No error has been found\./.test(text);
  const counterexample=/Invariant Safety is violated/.test(text)&&/The behavior up to this point is:/.test(text);
  return {status:exhausted?'satisfied_in_model':counterexample?'counterexample':'inconclusive',
    ...(counts?{generated:Number(counts[1].replaceAll(',','')),states:Number(counts[2].replaceAll(',',''))}:{}),
    exitCode,version:text.split(/\r?\n/).find(line=>/TLC2? Version/.test(line))||null};
}
export function compareResult(scenario,native,tlc,output){
  if(tlc.status!==native.status)return false;
  if(!scenario.fault)return tlc.status==='satisfied_in_model'&&tlc.states===native.states&&tlc.generated===native.transitions+1;
  // The independently ordered BFS queues may stop at different counterexamples.
  // Check the same violated predicate, not equality of queue sizes or trace text.
  return tlc.status==='counterexample'&&new RegExp(scenario.flag+'\\s*\\|->\\s*TRUE').test(output)
    &&(scenario.model!=='installation'||/valid\s*\|->\s*FALSE/.test(output));
}
export async function crosscheck({jar,output,java='java'}={}){
  if(!jar||!output)throw Error('Provide --jar with a local pinned TLC JAR and --output with an evidence directory. Nothing is downloaded.');
  const jarPath=await realpath(jar),out=path.resolve(output),jarBytes=await readFile(jarPath);
  if(hash(jarBytes,'sha1')!==TLC_PIN.sha1||hash(jarBytes)!==TLC_PIN.sha256)throw Error('The TLC JAR does not match the reviewed release fingerprints.');
  await mkdir(out,{recursive:true});
  const sourceFiles=['desktop/protocol-explorer.mjs','desktop/workflow-journal.mjs','desktop/update-completion.mjs','scripts/crosscheck-protocols.mjs','test/fixtures/protocol-models/Delivery.tla','test/fixtures/protocol-models/Installation.tla'];
  const sources={};for(const file of sourceFiles)sources[file]=hash(await readFile(path.join(root,file)));
  let javaVersion;try{const result=await execute(java,['-version'],{encoding:'utf8',timeout:10000,windowsHide:true});javaVersion=(result.stderr||result.stdout).trim();}catch(error){throw Error('Java is unavailable: '+String(error.message).slice(0,300));}
  const results=[];
  for(const scenario of CASES){
    const name=scenario.model+'-'+(scenario.fault||'baseline'),cwd=path.join(out,name);await mkdir(cwd,{recursive:true});
    await copyFile(path.join(root,'test','fixtures','protocol-models',scenario.module+'.tla'),path.join(cwd,scenario.module+'.tla'));
    const config='CONSTANT Fault = "'+(scenario.fault||'none')+'"\nINIT Init\nNEXT Next\nINVARIANT Safety\nCHECK_DEADLOCK FALSE\n';
    await writeFile(path.join(cwd,scenario.module+'.cfg'),config,'utf8');
    const args=['-Xmx256m','-cp',jarPath,'tlc2.TLC','-workers','1','-fp','0','-seed','1','-metadir',path.join(cwd,'states'),'-config',scenario.module+'.cfg',scenario.module+'.tla'];
    let raw,exitCode;try{const done=await execute(java,args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,windowsHide:true});raw=done.stdout+'\n'+done.stderr;exitCode=0;}catch(error){raw=String(error.stdout||'')+'\n'+String(error.stderr||'');exitCode=Number.isInteger(error.code)?error.code:null;}
    await writeFile(path.join(cwd,'tlc.log'),raw,'utf8');
    const tlc=parseTlcOutput(raw,exitCode),native=exploreProtocol(scenario.model,{broken:scenario.fault}),matches=compareResult(scenario,native,tlc,raw);
    results.push({name,model:scenario.model,deliberateFault:scenario.fault,matchingPredicatesAndBaselineCounts:matches,native,tlc,configSha256:hash(config),log:path.relative(out,path.join(cwd,'tlc.log')).replaceAll('\\','/')});
  }
  const unchanged=(await Promise.all(sourceFiles.map(async file=>sources[file]===hash(await readFile(path.join(root,file)))))).every(Boolean);
  const report={at:new Date().toISOString(),passed:unchanged&&results.every(result=>result.matchingPredicatesAndBaselineCounts),
    checker:{...TLC_PIN,observedSha1:hash(jarBytes,'sha1'),observedSha256:hash(jarBytes),javaVersion},
    sources,sourceBytesUnchanged:unchanged,models:PROTOCOL_MODELS,results,
    scope:'Original finite TLA+ translations checked by pinned independent TLC, compared with existing JavaScript explorer. Developer tooling only; no target app, personal data, runtime dependency or service call.',
    limitations:['Baseline comparisons match distinct reachable-state counts and generated-transition counts, not a bisimulation proof.',
      'Three deliberately broken variants must violate the corresponding safety predicates in both checkers.',
      'The state space uses the same listed finite bounds and assumptions as the JavaScript explorer. No general liveness, arbitrary concurrency, connector behavior or implementation correctness is proved.',
      'Production journal/receipt replay tests remain necessary. No third-party checker JAR is bundled in Exomina. TLA-TS itself is not evaluated by this TLC comparison.']};
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n','utf8');return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const options={};for(let n=2;n<process.argv.length;n+=2){const option=process.argv[n];if(!['--jar','--output','--java'].includes(option)||!process.argv[n+1])throw Error('Use --jar <file> --output <directory> [--java <executable>].');options[option.slice(2)]=process.argv[n+1];}const result=await crosscheck(options);process.stdout.write(JSON.stringify({passed:result.passed,results:result.results.map(item=>({name:item.name,matched:item.matchingPredicatesAndBaselineCounts,native:item.native.status,tlc:item.tlc.status,states:item.tlc.states,generated:item.tlc.generated}))})+'\n');if(!result.passed)process.exitCode=1;}
  catch(error){process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
}
