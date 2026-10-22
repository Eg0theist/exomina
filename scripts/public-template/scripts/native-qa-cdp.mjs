// Bounded, read-only diagnostics for the loopback endpoint of our own QA child.
// Keep only fixed protocol methods and target classifications, never page text.
import {ws as QaWebSocket} from 'playwright-core/lib/utilsBundle';
export function ownedBrowserEndpoint(endpoint){
 const value=new URL(endpoint);
 if(value.protocol!=='ws:'||value.hostname!=='127.0.0.1'||!value.port||value.username||value.password||value.search||value.hash||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(value.pathname))throw Error('Native QA requires its own loopback browser endpoint.');
 return value;
}
export function classifyQaTargets(targets){
 if(!Array.isArray(targets))return [];
 return targets.slice(0,32).map(target=>{
  let packagedRenderer=false;
  try{const value=new URL(target.url);packagedRenderer=value.protocol==='file:'&&/\/dist\/index\.html$/.test(value.pathname);}catch{}
  return {type:typeof target.type==='string'&&/^[a-z_]{1,30}$/.test(target.type)?target.type:'unknown',packagedRenderer};
 });
}
export async function probeOwnedBrowser(endpoint,{timeout=3000,fetchImpl=fetch,WebSocketImpl=QaWebSocket}={}){
 const owned=ownedBrowserEndpoint(endpoint),result={};
 try{
  const response=await fetchImpl(`http://127.0.0.1:${owned.port}/json/list`,{signal:AbortSignal.timeout(timeout),redirect:'error'});
  const targets=await response.json();result.httpTargets={reachable:true,status:response.status,targets:classifyQaTargets(targets)};
 }catch{result.httpTargets={reachable:false};}
 result.commands=[];
 let socket;
 try{
  socket=new WebSocketImpl(owned.href,{handshakeTimeout:timeout,followRedirects:false,maxPayload:256*1024});
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('timeout')),timeout);
   socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
   socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('transport'));},{once:true});
  });
  for(const [index,method] of ['Browser.getVersion','Target.getTargets'].entries()){
   const reply=await new Promise(resolve=>{
    const timer=setTimeout(()=>finish(null),timeout);
    const listener=event=>{try{const value=JSON.parse(String(event.data));if(value.id===index+1)finish(value);}catch{}};
    const finish=value=>{clearTimeout(timer);socket.removeEventListener('message',listener);resolve(value);};
    socket.addEventListener('message',listener);socket.send(JSON.stringify({id:index+1,method}));
   });
   const summary={method,responded:reply!==null};
   if(reply?.error)summary.protocolError=true;
   if(method==='Browser.getVersion'&&reply?.result)summary.versionReceived=typeof reply.result.product==='string';
   if(method==='Target.getTargets'&&reply?.result)summary.targets=classifyQaTargets(reply.result.targetInfos);
   result.commands.push(summary);
  }
 }catch{result.transportAvailable=false;}
 // A graceful close handshake can retain an unresponsive socket indefinitely.
 // Terminate the diagnostic connection; its error listener stays registered.
 finally{if(socket){try{socket.terminate();}catch{}}}
 return result;
}
