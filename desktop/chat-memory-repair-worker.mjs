import {parentPort,workerData} from 'node:worker_threads';
import {ChatMemoryTree} from './chat-memory-tree.mjs';

// Only the app's own tree API touches storage. This worker has no providers,
// account access, tools or network. The main tree waits asynchronously to write.
const tree=new ChatMemoryTree(workerData.dataDir,workerData.options);
try{
  const {chatId,cards}=workerData.request;
  const result=await tree.repairFollowupBatch(chatId,cards);
  await tree.close();
  parentPort.postMessage({result});
}catch(error){
  await tree.close().catch(()=>{});
  parentPort.postMessage({error:String(error.message||error)});
}
