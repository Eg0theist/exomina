import {parentPort,workerData} from 'node:worker_threads';
import {scanDirectory} from './disk-space.mjs';
import {nativeScan,nativeScanAvailable} from './disk-native.mjs';

const options={...workerData,onProgress:value=>parentPort.postMessage({type:'progress',value})};
const transfer=value=>{const data=value.treeData;return data?Object.values(data).filter(item=>ArrayBuffer.isView(item)).map(item=>item.buffer):[];};
async function run(){
 if(workerData.engine!=='compatibility'&&nativeScanAvailable()){
  try{return await nativeScan(options);}
  catch(error){
   // Security software or a missing helper must not leave the page without any answer.
   const result=await scanDirectory(options);
   return {...result,engineNote:'The fast scanner could not run ('+String(error?.message||error).slice(0,160)+'). This slower compatibility scan was used and measures logical sizes only.'};
  }
 }
 return scanDirectory(options);
}
run().then(value=>{const {nodes,...rest}=value;parentPort.postMessage({type:'done',value:rest},transfer(rest));},error=>parentPort.postMessage({type:'failure',error:error.message}));
