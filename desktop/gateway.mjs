import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
export async function createGateway({definitions,callTool,isActive}){
  const token=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    const given=Buffer.from(String(req.headers.authorization||'').replace(/^Bearer /,''));const expected=Buffer.from(token);
    if(req.headers.origin||given.length!==expected.length||!timingSafeEqual(given,expected)){res.writeHead(403);res.end('{}');return}
    if(req.method!=='POST'||req.url!=='/rpc'){res.writeHead(404);res.end('{}');return}
    let body='';try{for await(const chunk of req){body+=chunk;if(body.length>1048576)throw Error('Request too large')}
      const {method,params,conversationId}=JSON.parse(body);
      if(!isActive(conversationId))throw Error('This conversation has no active run.');
      if(method==='tools/list')res.end(JSON.stringify({tools:definitions(conversationId)}));
      else if(method==='tools/call')res.end(JSON.stringify(await callTool(params.name,params.arguments||{},conversationId)));
      else throw Error('Unsupported gateway method');
    }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}))}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {url:`http://127.0.0.1:${server.address().port}/rpc`,token,close:()=>server.close()};
}
