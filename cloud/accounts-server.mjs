import http from 'node:http';
import {AccountError} from './accounts.mjs';
import {RELAY_LIMITS} from './relay.mjs';
import {servePhone} from './phone-static.mjs';

// Thin JSON/HTTP layer over AccountService and, when given, the relay. TLS is terminated by the
// host (Caddy/nginx), not here.
const MAX_BODY=16*1024,MAX_RELAY_BODY=RELAY_LIMITS.maxBlob+4096;
const readBody=(req,max)=>new Promise((resolve,reject)=>{
  if(Number(req.headers['content-length']||0)>max){reject(new AccountError(413,'too_large','Request too large.'));req.resume();return;}
  let size=0;const chunks=[];
  req.on('data',(c)=>{size+=c.length;if(size>max){reject(new AccountError(413,'too_large','Request too large.'));req.destroy();}else chunks.push(c);});
  req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));req.on('error',reject);
});
const bearer=(req)=>/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1]||'';

export function createAccountServer(service,{relay=null,trustProxy=false,webRoot=null}={}){
  return http.createServer(async(req,res)=>{
    const send=(status,body)=>{if(res.writableEnded||res.destroyed)return;const text=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(text)});res.end(text);};
    try{
      if(webRoot&&await servePhone(req,res,webRoot))return;
      const ip=(trustProxy&&String(req.headers['x-forwarded-for']||'').split(',')[0].trim())||req.socket.remoteAddress||'unknown';
      const url=new URL(req.url,'http://local'),route=`${req.method} ${url.pathname}`;
      const raw=req.method==='GET'?'':await readBody(req,route==='POST /v1/relay/send'?MAX_RELAY_BODY:MAX_BODY);
      let json={};if(raw){try{json=JSON.parse(raw);}catch{throw new AccountError(400,'bad_json','Invalid request.');}}
      const signed=(opts)=>service.authenticate({method:req.method,path:url.pathname+url.search,body:raw,deviceId:req.headers['x-device'],ts:req.headers['x-ts'],nonce:req.headers['x-nonce'],signature:req.headers['x-sig']},opts);
      const needRelay=()=>{if(!relay)throw new AccountError(404,'not_found','Not found.');return relay;};
      switch(route){
        case 'POST /v1/signin/email':return send(200,await service.startEmail(json.email,ip));
        case 'POST /v1/signin/verify':return send(200,service.verifyEmail(json.signinId,json.code,ip));
        case 'POST /v1/signin/invite':return send(200,service.redeemInvite(json.code,ip));
        case 'POST /v1/devices':return send(200,service.registerDevice(bearer(req),json));
        case 'GET /v1/devices':return send(200,{devices:service.listDevices(signed())});
        case 'POST /v1/devices/approve':return send(200,service.approveDevice(signed(),json.deviceId,json.blob));
        case 'POST /v1/devices/claim':return send(200,service.claimApproval(signed({allowPending:true})));
        case 'POST /v1/devices/revoke':return send(200,service.revokeDevice(signed(),json.deviceId));
        case 'POST /v1/pair/ticket':return send(200,service.createPairingTicket(signed()));
        case 'POST /v1/pair/claim':return send(200,service.claimPairingTicket(json,ip));
        case 'POST /v1/relay/send':return send(200,needRelay().send(signed(),json));
        case 'GET /v1/relay/inbox':{
          const r=needRelay(),auth=signed(),wait=Math.max(0,Math.min(25,Number(url.searchParams.get('wait'))||0))*1000;
          const abort=new AbortController();res.on('close',()=>abort.abort());
          return send(200,await r.inbox(auth,{waitMs:wait,signal:abort.signal}));
        }
        case 'POST /v1/relay/ack':return send(200,needRelay().ack(signed(),json.seqs));
        case 'POST /v1/relay/reset':return send(200,needRelay().reset(signed()));
        case 'POST /v1/account/delete':return send(200,service.deleteAccount(signed()));
        case 'GET /v1/health':return send(200,{ok:true});
        default:return send(404,{error:'not_found'});
      }
    }catch(e){
      if(e instanceof AccountError)return send(e.status,{error:e.code,message:e.message});
      process.stderr.write(`account server error: ${e?.name||'Error'}\n`);return send(500,{error:'server_error'});
    }
  });
}
