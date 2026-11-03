import {mkdir,readFile,writeFile,rename,lstat,unlink} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {APP_VERSION} from './app-version.mjs';
import {remoteUrl,createRemoteFetch} from './remote-mcp-network.mjs';

export const SUNO_MCP={id:'suno',name:'Suno',transport:'http',url:'https://api.suno.com/mcp',enabled:false};
const key=url=>createHash('sha256').update(url).digest('hex');
const sameSecret=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
class RemoteMcpError extends Error{}
class RemoteMcpAuthTimeoutError extends RemoteMcpError{}
const signInExpired='Remote sign-in expired. Choose Connect again to open a fresh authorization page.';
async function untilAborted(operation,signal,{timeoutMs,timeoutMessage}={}){
 let abort,timer;const cancelled=new Promise((_,reject)=>{abort=()=>reject(Error('This remote connection was cancelled or changed.'));if(signal.aborted)abort();else{signal.addEventListener('abort',abort,{once:true});if(timeoutMs!==undefined)timer=setTimeout(()=>reject(new RemoteMcpError(timeoutMessage)),timeoutMs);}});
 try{return await Promise.race([cancelled,Promise.resolve().then(()=>{signal.throwIfAborted();return operation();})]);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
export function validateRemoteServer(server){
 if(!server||typeof server!=='object'||Array.isArray(server)||Object.keys(server).some(name=>!['id','name','transport','url','enabled'].includes(name)))throw Error('Use only id, name, transport, url and enabled for remote MCP.');
 if(server.transport!=='http'||typeof server.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(server.id)||typeof server.name!=='string'||!server.name.trim()||server.name.length>80||/[\x00-\x1f]/.test(server.name)||typeof server.enabled!=='boolean')throw Error('Invalid remote MCP configuration.');
 remoteUrl(server.url,{endpoint:true});return server;
}
export class RemoteMcpAuthStore{
 constructor({dataDir,encryption}){this.file=path.join(dataDir,'remote-mcp-credentials.json');this.encryption=encryption;this.records={};this.queue=Promise.resolve();}
 available(){if(this.unavailableError)throw Error(this.unavailableError);if(!this.encryption.isEncryptionAvailable()||this.encryption.getSelectedStorageBackend?.()==='basic_text')throw Error('Operating-system credential encryption is unavailable. Remote sign-in is disabled.');}
 async init(){try{await mkdir(path.dirname(this.file),{recursive:true});const stat=await lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1048576)throw Error('invalid file');const record=JSON.parse(await readFile(this.file,'utf8'));if(record.version!==1||!record.records||typeof record.records!=='object'||Array.isArray(record.records)||Object.keys(record.records).length>100||Object.entries(record.records).some(([name,value])=>!/^[a-f0-9]{64}$/.test(name)||typeof value!=='string'||value.length>131072||!/^[A-Za-z0-9+/]*={0,2}$/.test(value)))throw Error('invalid records');this.records=record.records;}catch(error){if(error.code!=='ENOENT')this.unavailableError='Remote sign-in is unavailable because its encrypted credential file could not be read. The file was preserved; repair or restore it before reconnecting. Other app features remain available.';}return this;}
 read(url){this.available();const stored=this.records[key(url)];if(!stored)return {};try{return JSON.parse(this.encryption.decryptString(Buffer.from(stored,'base64')));}catch{throw Error('This account could not unlock the remote connection. Remove it and sign in again.');}}
 async write(url,value){this.available();const encrypted=this.encryption.encryptString(JSON.stringify(value)).toString('base64');await this.update(url,encrypted);}
 async remove(url){if(this.unavailableError)throw Error(this.unavailableError);await this.update(url,undefined);}
 async update(url,value){const job=this.queue.catch(()=>{}).then(async()=>{const next={...this.records};if(value===undefined)delete next[key(url)];else next[key(url)]=value;const temp=this.file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify({version:1,records:next}),{encoding:'utf8',mode:0o600});await rename(temp,this.file);this.records=next;}finally{await unlink(temp).catch(()=>{});}});this.queue=job;return job;}
}
export async function oauthLoopback({previous,state,timeoutMs=600000,deferTimeout=false,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let resolve,reject,settled=false,cancelled=false,timedOut=false,started=!deferTimeout,timer;const result=new Promise((yes,no)=>{resolve=yes;reject=no;});result.catch(()=>{});
 const route=previous?new URL(previous).pathname:'/callback/'+randomUUID();
 const server=createServer((request,response)=>{
   const deny=()=>{response.writeHead(400,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end('This sign-in response was not accepted.');};
   let url;try{url=new URL(request.url,'http://'+request.headers.host);}catch{return deny();}
   if(settled||!started||request.method!=='GET'||request.headers.host!==`127.0.0.1:${server.address().port}`||url.pathname!==route||url.searchParams.getAll('state').length!==1||!sameSecret(url.searchParams.get('state'),state)||url.searchParams.getAll('code').length>1||url.searchParams.getAll('iss').length>1)return deny();
   if(!url.searchParams.get('code')&&!url.searchParams.get('error')||url.searchParams.get('code')&&url.searchParams.get('error')||(url.searchParams.get('code')||'').length>4096)return deny();
   settled=true;clearTimer(timer);response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"});response.end('<!doctype html><title>Exomina sign-in</title><p>Return to Exomina to check the connection.</p>');server.close();resolve(url.searchParams);
 });
 await new Promise((yes,no)=>{server.once('error',no);server.listen(previous?Number(new URL(previous).port):0,'127.0.0.1',yes);});
 const close=()=>{clearTimer(timer);if(!settled){settled=true;cancelled=true;reject(timedOut?new RemoteMcpAuthTimeoutError(signInExpired):Error('Remote sign-in was cancelled.'));}server.close();server.closeAllConnections?.();};
 const startTimeout=()=>{if(settled||timer)return;started=true;timer=setTimer(()=>{timedOut=true;close();},timeoutMs);};if(!deferTimeout)startTimeout();
 return {redirectUrl:`http://127.0.0.1:${server.address().port}${route}`,result,close,startTimeout,get cancelled(){return cancelled;},get timedOut(){return timedOut;}};
}
export class RemoteMcpClient{
 constructor(config,{authStore,approve,openExternal,isCurrent=()=>true,fetchImpl,timeoutMs=180000,oauthTimeoutMs=600000}={}){this.config=validateRemoteServer(config);Object.assign(this,{authStore,approve,openExternal,isCurrent,fetchImpl,timeoutMs,oauthTimeoutMs});this.dead=false;this.interactive=false;this.abort=new AbortController();}
 assertActive(){if(this.interactive&&this.loopback?.timedOut)throw new RemoteMcpAuthTimeoutError(signInExpired);if(this.dead||this.interactive&&this.loopback?.cancelled||!this.isCurrent(this.config))throw Error('This remote connection was cancelled or changed.');}
 async connect(){
  this.assertActive();this.authStore.available();const {Client,StreamableHTTPClientTransport,UnauthorizedError,checkResourceAllowed}=await import('@modelcontextprotocol/client');this.assertActive();const saved=this.authStore.read(this.config.url);let credentials={...saved},verifier,discovery,resourceIndicator,authorizationRequest;const state=randomBytes(32).toString('base64url');
  // Reuse this client registration's exact loopback URI. A busy previous port fails closed.
  const previous=typeof saved.redirectUrl==='string'&&/^http:\/\/127\.0\.0\.1:\d+\/callback\/[a-f0-9-]+$/.test(saved.redirectUrl)?saved.redirectUrl:undefined;
  if(saved.client&&!previous)throw new RemoteMcpError('This saved sign-in has no valid callback address. Remove the remote connection and add it again to register a new sign-in.');
  try{this.loopback=await oauthLoopback({previous,state,timeoutMs:this.oauthTimeoutMs,deferTimeout:true});}catch{throw new RemoteMcpError('The local sign-in callback address is unavailable. Close the program using it, or remove and add this remote connection to create a new sign-in.');}this.interactive=true;
  const persist=async()=>{this.assertActive();await this.authStore.write(this.config.url,{...credentials,redirectUrl:this.loopback.redirectUrl});this.assertActive();};
  const provider={
   redirectUrl:this.loopback.redirectUrl,clientMetadata:{client_name:'Exomina',redirect_uris:[this.loopback.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'},
   state:()=>state,clientInformation:()=>credentials.client,tokens:()=>credentials.tokens,
   saveClientInformation:async value=>{this.assertActive();credentials.client=value;await persist();},saveTokens:async value=>{this.assertActive();credentials.tokens=value;await persist();},
   saveCodeVerifier:value=>{this.assertActive();verifier=value;},codeVerifier:()=>{this.assertActive();if(!verifier)throw Error('The sign-in session expired.');return verifier;},
   saveDiscoveryState:value=>{this.assertActive();const metadata=value.authorizationServerMetadata;if(!metadata?.code_challenge_methods_supported?.includes('S256'))throw new RemoteMcpError('The authorization server must advertise PKCE S256 support.');for(const field of ['issuer','authorization_endpoint','token_endpoint'])remoteUrl(metadata[field]);if(metadata.registration_endpoint)remoteUrl(metadata.registration_endpoint);discovery=value;},discoveryState:()=>discovery,
   validateResourceURL:async(server,resource)=>{const expected=remoteUrl(this.config.url,{endpoint:true});if(String(server)!==expected.href||!resource||!checkResourceAllowed({requestedResource:expected,configuredResource:resource}))throw new RemoteMcpError('The authorization resource does not match the MCP address.');const chosen=remoteUrl(resource,{endpoint:true});resourceIndicator=chosen.href;return chosen;},
   invalidateCredentials:async scope=>{this.assertActive();if(scope==='all'||scope==='client')delete credentials.client;if(scope==='all'||scope==='tokens')delete credentials.tokens;if(scope==='all'||scope==='verifier')verifier=undefined;if(scope==='all'||scope==='discovery')discovery=undefined;await persist();},
   redirectToAuthorization:async input=>{this.assertActive();if(!this.interactive)throw new RemoteMcpError('Remote sign-in is required. Use Connect in Extensions.');const url=remoteUrl(String(input)),params=url.searchParams;if(!sameSecret(params.get('state'),state)||params.get('redirect_uri')!==this.loopback.redirectUrl||params.get('code_challenge_method')!=='S256'||params.get('resource')!==resourceIndicator)throw new RemoteMcpError('The sign-in request did not match this connection.');const scope=JSON.stringify((params.get('scope')||'(no scopes listed)').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300));authorizationRequest={url:url.href,approval:{title:`Sign in to ${this.config.name}?`,detail:`Connect Exomina to ${this.config.url}\nAuthorization service: ${url.origin}\nRequested access: ${scope}\nThis grants the service access according to its consent screen. Tool calls still require separate approval. Generation may consume your service credits.`,requireConfirmation:true,action:{kind:'network',tool:'remote_mcp_connect',target:this.config.url}}};}
  };
  const base=this.fetchImpl||createRemoteFetch({assertActive:()=>this.assertActive()});const fetcher=async(input,init={})=>{
   this.assertActive();let toolRequest=false;try{toolRequest=typeof init.body==='string'&&JSON.parse(init.body).method==='tools/call';}catch{}const response=await base(input,{...init,redirect:'error',signal:AbortSignal.any([this.abort.signal,...(init.signal?[init.signal]:[]),...(input instanceof Request?[input.signal]:[]),...(toolRequest&&this.toolSignal?[this.toolSignal]:[])])});
   // SDK OAuth retries may log parsing failures, including remote response text. Sanitize
   // both error statuses and malformed/error-shaped successful OAuth JSON before SDK parsing.
   const oauth=new URL(input instanceof Request?input.url:String(input)).href!==new URL(this.config.url).href;let value,invalid=false;
   if(response.status>=400||oauth){try{value=await response.json();}catch{invalid=true;}}
   if(response.status>=400||oauth&&(invalid||value?.error)){let code='server_error';if(['invalid_request','invalid_client','invalid_grant','unauthorized_client','unsupported_grant_type','invalid_scope','access_denied','invalid_token','insufficient_scope','temporarily_unavailable'].includes(value?.error))code=value.error;const headers=new Headers(response.headers);headers.delete('content-length');headers.set('content-type','application/json');return new Response(JSON.stringify({error:code,error_description:'The remote service refused this request.'}),{status:response.status>=400?response.status:400,headers});}
   if(oauth){const headers=new Headers(response.headers);headers.delete('content-length');return new Response(JSON.stringify(value),{status:response.status,headers});}
   return response;
  };
  const transport=()=>new StreamableHTTPClientTransport(new URL(this.config.url),{authProvider:provider,fetch:fetcher,requestInit:{redirect:'error'},onInsufficientScope:'throw',reconnectionOptions:{maxRetries:0}});
  // Keep SDK aggregation/output-schema validation while enforcing our limits on each page,
  // before its automatic pagination can request another page or cache an oversized catalog.
  const owner=this,BoundedClient=class extends Client{async request(message,options){const response=await super.request(message,options);if(message.method==='tools/list'){const budget=owner.discoveryBudget;if(!budget)throw new RemoteMcpError('Remote tool discovery was not requested.');budget.pages++;budget.tools+=response.tools?.length||0;budget.bytes+=Buffer.byteLength(JSON.stringify(response));if(budget.pages>20||budget.tools>500||budget.bytes>2000000)throw new RemoteMcpError('Remote tool discovery exceeds 20 pages, 500 tools or 2 MB.');const cursor=response.nextCursor;if(cursor!==undefined){if(typeof cursor!=='string'||!cursor||cursor.length>4096||budget.cursors.has(cursor))throw new RemoteMcpError('Remote tool discovery returned an invalid or repeated cursor.');budget.cursors.add(cursor);if(budget.pages===20)throw new RemoteMcpError('Remote tool discovery exceeds 20 pages.');}}return response;}};
  try{
   this.transport=transport();this.client=new BoundedClient({name:'exomina',version:APP_VERSION},{capabilities:{},listMaxPages:20});
   try{await this.client.connect(this.transport,{timeout:this.timeoutMs});}catch(error){
    if(!authorizationRequest||!(error instanceof UnauthorizedError))throw error;
    // Human consent has its own deadline, outside the SDK initialization request.
    // Reserve the callback before registration, but start expiry only when opening it.
    this.assertActive();if(!await untilAborted(()=>this.approve(authorizationRequest.approval),this.abort.signal))throw new RemoteMcpError('Remote sign-in was declined.');this.assertActive();this.loopback.startTimeout();await this.openExternal(authorizationRequest.url);
    const response=await this.loopback.result;this.assertActive();await untilAborted(()=>this.transport.finishAuth(response),this.abort.signal,{timeoutMs:this.timeoutMs,timeoutMessage:'Remote sign-in timed out while completing authorization. Choose Connect again to start a fresh sign-in. No tool was called.'});await this.client.close();this.transport=transport();this.client=new BoundedClient({name:'exomina',version:APP_VERSION},{capabilities:{},listMaxPages:20});await this.client.connect(this.transport,{timeout:this.timeoutMs});
   }
   this.assertActive();if(!this.client.getServerCapabilities()?.tools)throw Error('This remote MCP service exposes no tools.');
   return {connected:true};
  }catch(error){const expired=this.loopback?.timedOut,cancelled=this.dead||!this.isCurrent(this.config)||this.loopback?.cancelled;await this.close();throw Error(expired?signInExpired:cancelled?'This remote connection was cancelled or changed.':error instanceof RemoteMcpError?error.message:'Remote MCP connection or sign-in failed. Check the service address and retry Connect. No tool was called.');}
  finally{this.interactive=false;this.loopback?.close();verifier=undefined;}
 }
 async listTools(){this.assertActive();this.discoveryBudget={pages:0,tools:0,bytes:0,cursors:new Set()};try{const response=await this.client.listTools(undefined,{timeout:30000,cacheMode:'bypass'});this.assertActive();if(!Array.isArray(response.tools)||response.tools.length>500)throw Error('Remote MCP returned an invalid tool list.');this.tools=new Map(response.tools.map(tool=>[tool.name,tool]));return response.tools;}finally{this.discoveryBudget=undefined;}}
 async request(method,params,{signal}={}){this.assertActive();if(method!=='tools/call')throw Error('Unsupported remote MCP request.');if(this.toolSignal)throw Error('A remote tool is already active.');const stopped=()=>{if(signal?.aborted)throw Error('The remote tool was cancelled. Its effect is unknown; inspect the service before retrying.');};stopped();const requestSignal=AbortSignal.any([AbortSignal.timeout(90000),...(signal?[signal]:[])]);this.toolSignal=requestSignal;try{const toolDefinition=this.tools?.get(params.name);if(!toolDefinition)throw Error('Tool not discovered.');const result=await this.client.callTool(params,{timeout:90000,signal:requestSignal,toolDefinition});stopped();this.assertActive();return result;}catch{throw Error(signal?.aborted?'The remote tool was cancelled. Its effect is unknown; inspect the service before retrying.':'The remote tool failed or timed out. Its effect may be incomplete; inspect the service before retrying.');}finally{if(this.toolSignal===requestSignal)this.toolSignal=undefined;}}
 async close(){this.dead=true;this.interactive=false;this.abort.abort();this.loopback?.close();await this.client?.close().catch(()=>{});}
}
