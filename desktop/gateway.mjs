import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
export async function createGateway({definitions,callTool,isActive,getRun}){
  // A shared server never hands its root credential to a runtime. Capabilities
  // bind to the exact active run object, so a later turn cannot revive one.
  const token=getRun?undefined:randomBytes(32).toString('hex'),leases=new Map();
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const current=lease=>isActive(lease.conversationId)&&getRun(lease.conversationId)===lease.run;
  function forConversation(conversationId){
    if(!getRun)throw Error('This dedicated gateway does not issue shared capabilities.');
    const run=getRun(conversationId);if(!run||!isActive(conversationId))throw Error('This conversation has no active run.');
    for(const [key,lease]of leases)if(!current(lease))leases.delete(key);
    if(leases.size>=256)throw Error('Too many active tool bridge capabilities.');
    const secret=randomBytes(32).toString('hex'),key=digest(secret),lease={conversationId,run};leases.set(key,lease);
    return {url:address,token:secret,get script(){return result.script;},revoke(){leases.delete(key);}};
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    const given=Buffer.from(String(req.headers.authorization||'').replace(/^Bearer /,''));
    const lease=getRun&&given.length===64?leases.get(digest(given)):null;
    const expected=Buffer.from(token||'');
    const authenticated=getRun?!!lease&&current(lease):given.length===expected.length&&timingSafeEqual(given,expected);
    if(req.headers.origin||!authenticated){res.writeHead(403);res.end('{}');return}
    if(req.method!=='POST'||req.url!=='/rpc'){res.writeHead(404);res.end('{}');return}
    const chunks=[];let size=0;try{for await(const chunk of req){size+=chunk.length;if(size>1048576)throw Error('Request too large');chunks.push(chunk);}
      const {method,params,conversationId}=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
      if(lease&&conversationId!==lease.conversationId)throw Error('The tool capability belongs to another conversation.');
      if(!isActive(conversationId)||lease&&!current(lease))throw Error('This conversation has no active run.');
      const scope=lease?{isActive:()=>current(lease)}:undefined;
      if(method==='tools/list')res.end(JSON.stringify({tools:definitions(conversationId,scope)}));
      else if(method==='tools/call')res.end(JSON.stringify(await callTool(params.name,params.arguments||{},conversationId,scope)));
      else throw Error('Unsupported gateway method');
    }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}))}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const address=`http://127.0.0.1:${server.address().port}/rpc`;
  const result={url:address,token,...(getRun?{forConversation}:{}),close:()=>{leases.clear();server.close();}};return result;
}
