import {startExecutionHost} from './execution-host.mjs';
let host;
process.once('message',async config=>{try{host=await startExecutionHost(config);process.send?.({ready:true,pid:process.pid});process.disconnect?.();}catch(error){process.send?.({error:String(error.message)});process.exitCode=1;process.disconnect?.();}});
process.on('SIGTERM',()=>host?.close());
process.on('SIGINT',()=>host?.close());
