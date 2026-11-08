import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {evaluateDictation} from './dictation-evaluation.mjs';
import {installLocalDictation,LOCAL_DICTATION_ASSETS,LocalDictation} from '../desktop/dictation-local.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]||path.join(source,'../Workspace/daily-proof-20261108/dictation'));
const baselineRoot=path.resolve(process.argv[3]||path.join(source,'../Workspace/dictation-evaluation-20261108'));
await mkdir(output,{recursive:true});
const corpus=JSON.parse(await readFile(path.join(source,'test/fixtures/dictation-evaluation-corpus.json'),'utf8'));
const baselineRecords=JSON.parse(await readFile(path.join(baselineRoot,'recognition-records.json'),'utf8'));
const root=path.join(output,'managed');
await installLocalDictation(root,{fetchImpl:async url=>new Response(await readFile(path.join(output,url===LOCAL_DICTATION_ASSETS.runtime.url?'whisper-bin-x64.zip':'ggml-base.bin')))});
await new LocalDictation({root}).verify();
const recordings=[],wavs=[];
for(const item of corpus.cases){
  const file=path.join(baselineRoot,'audio',item.id+'.wav'),audio=await readFile(file),start=performance.now();
  const row=await new Promise((resolve,reject)=>{
    const child=spawn(path.join(root,'whisper-cli.exe'),['-m',path.join(root,'ggml-base.bin'),'-f',file,'-l',item.language.split('-')[0],'-t','4','--no-gpu','--no-fallback','--no-prints','--no-timestamps'],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,GGML_BACKEND_PATH:root}});
    let text='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',bytes=>{text+=bytes;if(text.length>20000)child.kill();});child.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-5000));
    const timer=setTimeout(()=>child.kill(),120000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(`Whisper case ${item.id} failed (${code}): ${stderr}`));else resolve({id:item.id,language:item.language,text:text.trim(),recognitionProcessingMs:performance.now()-start,audioDurationMs:(audio.length-44)/32000*1000,wave:item.id+'.wav'});});
  });
  recordings.push(row);wavs.push({file:row.wave,bytes:audio.length,sha256:createHash('sha256').update(audio).digest('hex')});
}
const engine={name:'whisper.cpp1.9.5 multilingual base CPU',version:LOCAL_DICTATION_ASSETS.version,release:LOCAL_DICTATION_ASSETS.release,model:LOCAL_DICTATION_ASSETS.model,threads:4,temperatureFallback:false,vocabularyPrompt:false,timingDefinition:'Separate native process per completed WAV, including process start/model load/decode; OS file caches uncontrolled. No microphone/streaming latency measurement.'};
const candidate=evaluateDictation(corpus,recordings,{engine,mode:'raw'});
const baseline=evaluateDictation(corpus,baselineRecords.recordings,{engine:{name:'Windows System.Speech original frozen baseline',metadata:baselineRecords.metadata},mode:'raw'});
const report={at:new Date().toISOString(),scope:'Actual pinned local CPU inference over identical frozen synthetic English/German WAVs. No human microphone, cloud transcription, cleanup or vocabulary prompt.',baseline,candidate,wavs,passedRecognitionImprovement:candidate.summary.wer<baseline.summary.wer,qualityAccepted:candidate.summary.wer<=0.15&&candidate.summary.protected.negations.preserved===candidate.summary.protected.negations.total&&candidate.summary.protected.commands.preserved===candidate.summary.protected.commands.total,limits:candidate.limits};
await writeFile(path.join(output,'recognition-records-local.json'),JSON.stringify({engine,recordings},null,2),'utf8');
await writeFile(path.join(output,'comparison.json'),JSON.stringify(report,null,2),'utf8');
console.log(JSON.stringify({output,baseline:baseline.summary,candidate:candidate.summary,passedRecognitionImprovement:report.passedRecognitionImprovement,qualityAccepted:report.qualityAccepted}));
