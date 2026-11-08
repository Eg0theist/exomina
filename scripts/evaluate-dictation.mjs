import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {evaluateDictation} from './dictation-evaluation.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),corpusPath=path.join(root,'test/fixtures/dictation-evaluation-corpus.json'),output=path.resolve(process.argv[2]||path.join(root,'../Workspace/dictation-evaluation-20261108'));
await mkdir(output,{recursive:true});const corpus=JSON.parse(await readFile(corpusPath,'utf8'));const audio=path.join(output,'audio');await mkdir(audio,{recursive:true});
const started=performance.now(),lines=[];let pending='',stderr='',metadata,firstMetadataMs;
const recordsIndex=process.argv.indexOf('--records'),recordingsFile=recordsIndex>=0?path.resolve(process.argv[recordsIndex+1]):null,existingRecords=recordingsFile?JSON.parse(await readFile(recordingsFile,'utf8')):null;
let exitCode=0;
if(existingRecords){metadata=existingRecords.metadata;lines.push(...existingRecords.recordings);}else{
if(process.platform!=='win32')throw Error('This adapter evaluates installed Windows System.Speech only. Provide external recognition records to the pure evaluateDictation module for other engines.');
const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/evaluate-dictation-windows.ps1'),'-CorpusPath',corpusPath,'-OutputDirectory',audio],{windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);});
child.stdout.on('data',chunk=>{pending+=chunk;let newline;while((newline=pending.indexOf('\n'))!==-1){const text=pending.slice(0,newline).trim();pending=pending.slice(newline+1);if(!text)continue;try{const row=JSON.parse(text);if(row.type==='metadata'){metadata=row;firstMetadataMs=performance.now()-started;}else if(row.type==='case')lines.push(row);}catch{stderr+='\nUnparsed output: '+text.slice(0,400);}}});
const timer=setTimeout(()=>child.kill(),180000);try{exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
}
const sourceAudio=recordingsFile?path.join(path.dirname(recordingsFile),'audio'):audio;
const wavs=[];for(const row of lines.filter(item=>item.wave)){if(!/^[a-z0-9-]{1,80}\.wav$/.test(row.wave))throw Error('Use a corpus WAV basename.');const bytes=await readFile(path.join(sourceAudio,row.wave));const dataOffset=bytes.indexOf(Buffer.from('data'));if(dataOffset>=0&&dataOffset+8<bytes.length)row.audioDurationMs=bytes.readUInt32LE(dataOffset+4)/32000*1000;wavs.push({file:row.wave,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const engine={name:'Windows System.Speech Recognition DictationGrammar',adapter:'existing Windows desktop recognition engine API',version:metadata?.runtime||'unknown',platform:metadata?.platform||process.platform,recognizers:metadata?.recognizers||[],voices:metadata?.voices||[],timingDefinition:metadata?.timingDefinition||'',freshProcessMetadataReadyMs:firstMetadataMs??null};
const raw=evaluateDictation(corpus,lines,{engine,mode:'raw'}),minimal=evaluateDictation(corpus,lines,{engine,mode:'minimal',vocabulary:['Exomina','Hamburg','Mara','Aurora','Berlin']});
const languages=Object.fromEntries([...new Set(corpus.cases.map(row=>row.language))].map(language=>{const subset={...corpus,cases:corpus.cases.filter(row=>row.language===language)};return[language,{raw:evaluateDictation(subset,lines,{engine,mode:'raw'}).summary,minimal:evaluateDictation(subset,lines,{engine,mode:'minimal',vocabulary:['Exomina','Hamburg','Mara','Aurora','Berlin']}).summary}];}));
const report={at:new Date().toISOString(),completed:exitCode===0,exitCode,rescoredExistingRecords:!!existingRecords,scope:'Real installed offline Windows engine, original synthetic German/English TTS WAV corpus. No microphone, playback, model downloads, remote calls or account stores.',metadata,raw,minimal,languages,wavs,...(stderr?{diagnostics:stderr}:{}),totalWallMs:performance.now()-started};
await writeFile(path.join(output,'recognition-records.json'),JSON.stringify({metadata,recordings:lines},null,2),'utf8');await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify({output,completed:report.completed,exitCode,raw:raw.summary,minimal:minimal.summary}));if(exitCode!==0)process.exitCode=1;
