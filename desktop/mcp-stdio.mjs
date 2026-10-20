import readline from 'node:readline';
import { APP_VERSION } from './app-version.mjs';
const gateway=process.env.EXOMINA_TOOL_GATEWAY;
if(!gateway||!/^http:\/\/127\.0\.0\.1:\d+\/rpc$/.test(gateway)){process.stderr.write('Missing local Exomina gateway.\n');process.exit(1)}
const ALWAYS_LOAD=new Set(['memory_note','memory_recall']);
const respond=value=>process.stdout.write(JSON.stringify(value)+'\n');
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',async line=>{
  if(line.length>1048576)return;let request;
  try{request=JSON.parse(line);if(request.id===undefined)return;
    let result;
    if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'exomina',version:APP_VERSION}};
    else if(request.method==='ping')result={};
    else if(['tools/list','tools/call'].includes(request.method)){
      const r=await fetch(gateway,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.EXOMINA_TOOL_TOKEN}`},body:JSON.stringify({method:request.method,params:request.params,conversationId:process.env.EXOMINA_TOOL_CONVERSATION}),signal:AbortSignal.timeout(600000)});
      result=await r.json();if(!r.ok)throw Error(result.error||'Gateway rejected request');
      // Memory tools are used constantly; keep their schemas loaded so they are never mistaken for missing.
      if(request.method==='tools/list'&&Array.isArray(result.tools))result.tools=result.tools.map(t=>ALWAYS_LOAD.has(t.name)?{...t,_meta:{...t._meta,'anthropic/alwaysLoad':true}}:t);
    }else {respond({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}});return}
    respond({jsonrpc:'2.0',id:request.id,result});
  }catch(e){respond({jsonrpc:'2.0',id:request?.id??null,error:{code:-32000,message:e.message}})}
});
