import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';

export function remoteUrl(value,{endpoint=false}={}){
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20]/.test(value))throw Error('Use a public HTTPS MCP address.');
  let url;try{url=new URL(value);}catch{throw Error('Use a public HTTPS MCP address.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||url.hostname.endsWith('.')||isIP(url.hostname.replace(/^\[|\]$/g,''))||!url.hostname.includes('.')||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||(endpoint&&url.search))throw Error('Remote MCP requires a public HTTPS hostname on port 443, without credentials, fragments or endpoint query parameters.');
  if([...url.searchParams.keys()].some(key=>/^(access_token|refresh_token|client_secret|code_verifier)$/i.test(key)))throw Error('Credentials must not appear in remote URLs.');
  return url;
}
export function publicAddress(address){
  if(isIP(address)===4){const n=address.split('.').map(Number);return !(n[0]===0||n[0]===10||n[0]===127||n[0]>=224||n[0]===169&&n[1]===254||n[0]===172&&n[1]>=16&&n[1]<=31||n[0]===192&&(n[1]===168||n[1]===0&&[0,2].includes(n[2]))||n[0]===100&&n[1]>=64&&n[1]<=127||n[0]===198&&[18,19].includes(n[1])||n[0]===198&&n[1]===51&&n[2]===100||n[0]===203&&n[1]===0&&n[2]===113);}
  if(isIP(address)===6){const [first,second]=address.split(':').map(part=>parseInt(part||'0',16));return /^[23][0-9a-f]{3}:/i.test(address)&&!(first===0x2001&&(second<=0x1ff||second===0xdb8))&&![0x2002,0x3ffe,0x3fff].includes(first);}
  return false;
}
// Pin the checked DNS result to the actual TLS socket. A preflight-only DNS check is insufficient.
export function createRemoteFetch({lookupImpl=lookup,requestImpl=https.request,assertActive=()=>{}}={}){
 return async(input,init={})=>{
  assertActive();const url=remoteUrl(input instanceof Request?input.url:String(input));
  if(input instanceof Request){const merged={method:input.method,headers:input.headers,signal:input.signal,...init};if(merged.body===undefined&&input.body){const reader=input.clone().body.getReader(),chunks=[];let bytes=0;try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1000000)throw Error('Remote request exceeds 1 MB.');chunks.push(Buffer.from(part.value));}}finally{await reader.cancel().catch(()=>{});}merged.body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}init=merged;}
  const addresses=await lookupImpl(url.hostname,{all:true,verbatim:true});assertActive();
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw Error('Remote MCP addresses must resolve only to public internet hosts.');
  const pinned=addresses[0],headers=Object.fromEntries(new Headers(init.headers||input?.headers||{}));
  const body=init.body;if(body!==undefined&&body!==null&&typeof body!=='string'&&!(body instanceof URLSearchParams))throw Error('Unsupported remote request body.');
  if(body&&Buffer.byteLength(String(body))>1000000)throw Error('Remote request exceeds 1 MB.');
  return new Promise((resolve,reject)=>{
    const request=requestImpl(url,{method:init.method||'GET',headers,lookup:(_host,options,callback)=>options.all?callback(null,addresses):callback(null,pinned.address,pinned.family),autoSelectFamily:true,agent:false},response=>{
      try{
      if(!Number.isInteger(response.statusCode)||response.statusCode<200||response.statusCode>599)throw Error('Remote MCP returned an invalid HTTP status.');
      if(response.statusCode>=300&&response.statusCode<400){response.destroy();reject(Error('Remote MCP redirects are refused. Use the final service address.'));return;}
      const length=Number(response.headers['content-length']||0);if(length>40000000){response.destroy();reject(Error('Remote response exceeds 40 MB.'));return;}
      let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>40000000)response.destroy(Error('Remote response exceeds 40 MB.'));});
      const status=response.statusCode||500,body=[204,205,304].includes(status)?null:Readable.toWeb(response);
      resolve(new Response(body,{status,headers:response.headers}));
      }catch{response.destroy();reject(Error('Remote MCP returned an invalid HTTP response.'));}
    });
    request.setTimeout(90000,()=>request.destroy(Error('Remote MCP connection timed out. Its effect is unknown; inspect before retrying.')));
    const abort=()=>request.destroy(Error('Remote MCP request cancelled.'));init.signal?.addEventListener('abort',abort,{once:true});request.on('close',()=>init.signal?.removeEventListener('abort',abort));request.on('error',()=>reject(Error('Remote MCP network request failed. Its effect may be incomplete; inspect before retrying.')));
    if(init.signal?.aborted)abort();else request.end(body===undefined?undefined:String(body),'utf8');
  });
 };
}
