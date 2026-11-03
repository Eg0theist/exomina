import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {get as httpGet} from 'node:http';
import {PassThrough} from 'node:stream';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {RemoteMcpAuthStore,RemoteMcpClient,oauthLoopback,validateRemoteServer,SUNO_MCP} from '../desktop/remote-mcp.mjs';
import {remoteUrl,publicAddress,createRemoteFetch} from '../desktop/remote-mcp-network.mjs';
import {ExternalMcpTools} from '../desktop/external-mcp.mjs';

const config={id:'fixture',name:'Synthetic service',transport:'http',url:'https://music.example.test/mcp',enabled:true};
async function store(t){const dataDir=await mkdtemp(path.join(os.tmpdir(),'exomina-remote-mcp-'));assert.equal(path.dirname(dataDir),os.tmpdir());t.after(()=>rm(dataDir,{recursive:true,force:true}));const key=randomBytes(32),encryption={isEncryptionAvailable:()=>true,encryptString(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);},decryptString(value){const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8');}};const result=await new RemoteMcpAuthStore({dataDir,encryption}).init();return {dataDir,result,encryption};}
test('remote config permits exact public HTTPS endpoints and rejects credentials, private URLs and executable fields',()=>{
 assert.equal(validateRemoteServer(SUNO_MCP),SUNO_MCP);
 for(const url of ['http://example.test/mcp','https://127.0.0.1/mcp','https://[::1]/mcp','https://user:secret@example.test/mcp','https://example.test:8443/mcp','https://example.test/mcp?token=x','https://example.local/mcp','https://example.test./mcp'])assert.throws(()=>validateRemoteServer({...config,url}));
 assert.throws(()=>validateRemoteServer({...config,command:'node'}));assert.throws(()=>remoteUrl('https://example.test/token?access_token=secret'));
 for(const ip of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','172.16.4.3','192.168.0.1','192.0.2.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700::1111'),true);
});
test('network checks every DNS answer, pins the TLS lookup and refuses redirect responses',async()=>{
 let dispatched=0,pinned;const lookupImpl=async()=>[{address:'8.8.8.8',family:4}];
 const requestImpl=(_url,options,callback)=>{dispatched++;options.lookup('ignored',{},(error,address)=>{assert.ifError(error);pinned=address;});const emitter=new EventEmitter();emitter.setTimeout=()=>{};emitter.destroy=()=>{};emitter.end=()=>{const response=new PassThrough();response.statusCode=302;response.headers={location:'https://other.example.test'};callback(response);};return emitter;};
 await assert.rejects(createRemoteFetch({lookupImpl:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],requestImpl})(config.url),/only to public/);assert.equal(dispatched,0);
 await assert.rejects(createRemoteFetch({lookupImpl,requestImpl})(config.url),/redirects are refused/);assert.equal(pinned,'8.8.8.8');assert.equal(dispatched,1);
});
test('malformed asynchronous HTTP status rejects without escaping the response callback',async()=>{
 for(const status of [199,600,NaN]){let destroyed=false;const requestImpl=(_url,_options,callback)=>{const emitter=new EventEmitter();emitter.setTimeout=()=>{};emitter.destroy=()=>{};emitter.end=()=>setImmediate(()=>{const response=new PassThrough();response.statusCode=status;response.headers={};response.on('close',()=>destroyed=true);callback(response);});return emitter;};await assert.rejects(createRemoteFetch({lookupImpl:async()=>[{address:'8.8.8.8',family:4}],requestImpl})(config.url),/invalid HTTP response/);await new Promise(resolve=>setImmediate(resolve));assert.equal(destroyed,true);}
});
test('encrypted credential store does not expose plaintext and refuses plaintext OS backends',async t=>{
 const f=await store(t);await f.result.write(config.url,{tokens:{access_token:'synthetic-access-secret'}});const raw=await readFile(f.result.file,'utf8');assert.equal(raw.includes('synthetic-access-secret'),false);assert.equal(f.result.read(config.url).tokens.access_token,'synthetic-access-secret');assert.deepEqual(f.result.read('https://different.example.test/mcp'),{});
 f.encryption.getSelectedStorageBackend=()=> 'basic_text';assert.throws(()=>f.result.read(config.url),/encryption is unavailable/);delete f.encryption.getSelectedStorageBackend;
 await f.result.remove(config.url);assert.deepEqual(f.result.read(config.url),{});
});
test('corrupt remote credentials disable only the service and preserve the original file during startup and writes',async t=>{
 const f=await store(t);await writeFile(f.result.file,'corrupt encrypted fixture','utf8');
 const reopened=await new RemoteMcpAuthStore({dataDir:f.dataDir,encryption:f.encryption}).init();assert.equal(typeof reopened.unavailableError,'string');assert.throws(()=>reopened.available(),/Other app features remain available/);await assert.rejects(reopened.write(config.url,{tokens:{access_token:'never-saved'}}),/preserved/);await assert.rejects(reopened.remove(config.url),/preserved/);assert.equal(await readFile(f.result.file,'utf8'),'corrupt encrypted fixture');
});
test('Request objects preserve their POST body and special IPv6 networks never reach a socket',async()=>{
 let captured;const requestImpl=(_url,options,callback)=>{const emitter=new EventEmitter();emitter.setTimeout=()=>{};emitter.destroy=()=>{};emitter.end=body=>{captured={method:options.method,body};const response=new PassThrough();response.statusCode=200;response.headers={};callback(response);response.end('{}');};return emitter;};
 const response=await createRemoteFetch({lookupImpl:async()=>[{address:'8.8.8.8',family:4}],requestImpl})(new Request(config.url,{method:'POST',body:'{"method":"initialize"}'}));assert.equal(await response.text(),'{}');assert.deepEqual(captured,{method:'POST',body:'{"method":"initialize"}'});
 for(const ip of ['2001::1','2001:20::1','2001:1ff::1','3fff::1','3ffe::1'])assert.equal(publicAddress(ip),false,ip);assert.equal(publicAddress('2001:4860::1'),true);
});
test('loopback callback enforces exact state, Host, path and single code, then closes',async()=>{
 const loop=await oauthLoopback({state:'fixture-state',timeoutMs:1000});try{
  assert.equal((await fetch(loop.redirectUrl+'?state=bad&code=x')).status,400);
  assert.equal((await fetch(loop.redirectUrl+'?state=fixture-state&code=x&code=y')).status,400);
  assert.equal(await new Promise((resolve,reject)=>httpGet(loop.redirectUrl+'?state=fixture-state&code=x',{headers:{Host:'attacker.test'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject)),400);
  assert.equal((await fetch(loop.redirectUrl+'?state=fixture-state&code=synthetic-code')).status,200);assert.equal((await loop.result).get('code'),'synthetic-code');
 }finally{loop.close();}
 const timed=await oauthLoopback({state:'another',timeoutMs:10});await assert.rejects(timed.result,/sign-in expired.*Connect again/);assert.equal(timed.cancelled,true);assert.equal(timed.timedOut,true);
});
test('deferred callback expiry starts when authorization opens and refuses callbacks before consent',async()=>{
 const loop=await oauthLoopback({state:'deferred-fixture',timeoutMs:30,deferTimeout:true});try{
  await new Promise(resolve=>setTimeout(resolve,60));assert.equal(loop.timedOut,false);
  assert.equal((await fetch(loop.redirectUrl+'?state=deferred-fixture&code=too-early')).status,400);
  loop.startTimeout();assert.equal((await fetch(loop.redirectUrl+'?state=deferred-fixture&code=approved')).status,200);assert.equal((await loop.result).get('code'),'approved');assert.equal(loop.timedOut,false);
 }finally{loop.close();}
});
function fixtureRemote({s256=true,resource=config.url,onOpen=()=>{},allow=true,scope='music:read',callbackIssuer}={}){
 const requests=[],approvals=[];let codeChallenge;
 const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
 const fetchImpl=async(input,options={})=>{
  const url=new URL(String(input));requests.push({url:url.href,method:options.method,body:options.body,authorization:new Headers(options.headers).get('authorization')});
  if(url.hostname==='music.example.test'&&url.pathname==='/mcp'){
   if(options.method==='GET')return new Response(null,{status:405});
   if(new Headers(options.headers).get('authorization')!=='Bearer synthetic-access')return response({},401,{'WWW-Authenticate':'Bearer resource_metadata="https://music.example.test/.well-known/oauth-protected-resource/mcp"'});
   const message=JSON.parse(options.body||'{}');if(message.id===undefined)return new Response(null,{status:202});
   const result=message.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Synthetic remote fixture',version:'1'}}:message.method==='tools/list'?{tools:[{name:'echo',description:'Fixture only',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:{content:[{type:'text',text:message.params.arguments.text}]};
   return response({jsonrpc:'2.0',id:message.id,result});
  }
  if(url.pathname.includes('oauth-protected-resource'))return response({resource,authorization_servers:['https://auth.example.test'],scopes_supported:[scope]});
  if(url.pathname.includes('.well-known'))return response({issuer:'https://auth.example.test',authorization_endpoint:'https://auth.example.test/authorize',token_endpoint:'https://auth.example.test/token',registration_endpoint:'https://auth.example.test/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],...(s256?{code_challenge_methods_supported:['S256']}:{})});
  if(url.pathname==='/register')return response({...JSON.parse(options.body),client_id:'synthetic-client'});
  if(url.pathname==='/token'){const params=new URLSearchParams(options.body);assert.equal(params.get('resource'),new URL(resource).href);assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),codeChallenge);return response({access_token:'synthetic-access',token_type:'Bearer',refresh_token:'synthetic-refresh',scope:'music:read'});}
  throw Error('Unexpected fixture URL: '+url.href);
 };
 const openExternal=async value=>{const url=new URL(value);codeChallenge=url.searchParams.get('code_challenge');assert.equal(url.searchParams.get('code_challenge_method'),'S256');onOpen();const callback=new URL(url.searchParams.get('redirect_uri'));callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','synthetic-code');if(callbackIssuer)callback.searchParams.set('iss',callbackIssuer);const response=await fetch(callback);assert.equal(response.status,200);};
 return {requests,approvals,fetchImpl,openExternal,approve:async input=>{approvals.push(input);return allow;}};
}
test('official SDK completes synthetic PKCE OAuth, discovers and calls tools without sending a generation',async t=>{
 const f=await store(t),remote=fixtureRemote(),client=new RemoteMcpClient(config,{authStore:f.result,...remote});t.after(()=>client.close());
 await client.connect();assert.equal((await client.listTools())[0].name,'echo');const result=await client.request('tools/call',{name:'echo',arguments:{text:'Test ä'}});assert.equal(result.content[0].text,'Test ä');assert.equal(remote.approvals.length,1);assert.equal(remote.approvals[0].requireConfirmation,true);assert.equal(remote.requests.some(item=>item.url.includes('access_token=')),false);
 assert.equal(f.result.read(config.url).tokens.access_token,'synthetic-access');assert.equal(client.interactive,false);
});
test('OAuth refuses missing advertised S256, mismatched resources and declined authorization before opening a browser',async t=>{
 for(const options of [{s256:false},{resource:'https://other.example.test/mcp'},{allow:false}]){const f=await store(t);let opened=false;const remote=fixtureRemote({...options,onOpen:()=>opened=true}),client=new RemoteMcpClient(config,{authStore:f.result,...remote});await assert.rejects(client.connect());assert.equal(opened,false);assert.equal(remote.requests.some(item=>item.url.endsWith('/token')),false);}
});
test('cancel during authorization confirmation settles immediately without waiting for the popup and ignores late consent',async t=>{
 const f=await store(t),remote=fixtureRemote();let release,entered;const ready=new Promise(resolve=>entered=resolve);let opened=false;
 const client=new RemoteMcpClient(config,{authStore:f.result,...remote,approve:()=>{entered();return new Promise(resolve=>release=resolve);},openExternal:()=>{opened=true;}});
 const connecting=client.connect(),rejected=assert.rejects(connecting,/cancelled|changed/);await ready;await client.close();let timeout;try{await Promise.race([rejected,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Connect is still waiting for the unanswered approval')),1000);})]);}finally{clearTimeout(timeout);}assert.equal(opened,false);await f.result.remove(config.url);release(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(opened,false);assert.deepEqual(f.result.read(config.url),{});
});
test('removal serializes behind an in-flight encrypted token write so late auth cannot resurrect credentials',async t=>{
 const f=await store(t),remote=fixtureRemote(),original=f.result.write.bind(f.result);let release,entered;const ready=new Promise(resolve=>entered=resolve);
 f.result.write=(url,value)=>{if(value.tokens){f.result.queue=new Promise(resolve=>release=resolve);const pending=original(url,value);entered();return pending;}return original(url,value);};
 const client=new RemoteMcpClient(config,{authStore:f.result,...remote}),connecting=client.connect(),rejected=assert.rejects(connecting,/cancelled|changed/);await ready;await client.close();const removed=f.result.remove(config.url);release();await removed;await rejected;assert.deepEqual(f.result.read(config.url),{});assert.equal((await readFile(f.result.file,'utf8')).includes('synthetic-access'),false);
});
test('external HTTP connection and each tool call require consent; disconnect cancels pending auth while retaining unrelated definitions',async()=>{
 const settings={externalMcpServers:[config]},approvals=[],client={dead:false,async connect(){},async listTools(){return [{name:'echo',inputSchema:{type:'object'}}];},async request(){return {content:[{type:'text',text:'done'}]};},async close(){this.dead=true;}};
 const tools=new ExternalMcpTools({getSettings:()=>settings,approve:async request=>{approvals.push(request);return true;},createRemoteClient:()=>client});
 await tools.refresh(undefined,{requestApproval:false});assert.equal(approvals.length,0);assert.equal(tools.definitions.length,0);
 await tools.refresh();assert.equal(tools.definitions.length,1);assert.equal(approvals[0].requireConfirmation,true);await tools.call(tools.definitions[0].name,{});assert.equal(approvals[1].requireConfirmation,true);assert.match(approvals[1].detail,/credits/);
 settings.externalMcpServers[0]={...config,enabled:false};await tools.disconnect(config.id);assert.equal(client.dead,true);assert.equal(tools.definitions.length,0);
});
test('remote tool arguments must fit the full approval display, with no truncated consent or dispatch',async()=>{
 let approvals=0,calls=0;const settings={externalMcpServers:[config]},client={dead:false,async connect(){},async listTools(){return [{name:'echo',inputSchema:{type:'object'}}];},async request(){calls++;return {content:[]};},async close(){}};
 const tools=new ExternalMcpTools({getSettings:()=>settings,approve:async()=>{approvals++;return true;},createRemoteClient:()=>client});await tools.refresh();const result=await tools.call(tools.definitions[0].name,{text:'x'.repeat(24000)});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/complete approval display limit/);assert.equal(approvals,1);assert.equal(calls,0);await tools.close();
});
test('Stop reaches remote SDK calls and suppresses success after abort without closing the shared connection',async()=>{
 const controller=new AbortController(),client=new RemoteMcpClient(config,{authStore:{}});client.tools=new Map([['echo',{name:'echo',inputSchema:{type:'object'}}]]);let sdkSignal;client.client={async callTool(_params,options){sdkSignal=options.signal;controller.abort();return {content:[]};}};
 await assert.rejects(client.request('tools/call',{name:'echo',arguments:{}},{signal:controller.signal}),/effect is unknown/);assert.equal(sdkSignal.aborted,true);assert.equal(client.dead,false);
 let approvals=0,requests=0,received;const second=new AbortController(),settings={externalMcpServers:[config]},remote={dead:false,async connect(){},async listTools(){return [{name:'echo',inputSchema:{type:'object'}}];},async request(_method,_params,options){requests++;received=options.signal;second.abort();return {content:[{type:'text',text:'must-not-report-success'}]};},async close(){}};
 const tools=new ExternalMcpTools({getSettings:()=>settings,approve:async()=>{approvals++;return true;},createRemoteClient:()=>remote});await tools.refresh();const name=tools.definitions[0].name,result=await tools.call(name,{},'chat',{signal:second.signal});assert.equal(received,second.signal);assert.equal(result.isError,true);assert.match(result.content[0].text,/effect is unknown/);assert.doesNotMatch(result.content[0].text,/must-not-report-success/);await tools.call(name,{},'chat',{signal:second.signal});assert.equal(requests,1);assert.equal(approvals,2);assert.equal(remote.dead,false);await tools.close();
});
test('malformed successful OAuth responses and error descriptions cannot enter SDK warning logs',async()=>{
 for(const tokenResponse of ['SYNTHETIC-SECRET-MARKER',JSON.stringify({error:'invalid_grant',error_description:'SYNTHETIC-SECRET-MARKER'})]){
  const callback=await oauthLoopback({state:'log-fixture'});const redirectUrl=callback.redirectUrl;callback.close();
  const issuer='https://auth.example.test',saved={redirectUrl,client:{client_id:'fixture-client',issuer},tokens:{access_token:'expired',refresh_token:'refresh',token_type:'Bearer',issuer}},logs=[],warn=console.warn;let tokenRequests=0;
  const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
  const client=new RemoteMcpClient(config,{authStore:{available(){},read:()=>structuredClone(saved),async write(){}},approve:async()=>false,openExternal:()=>{throw Error('Must not open');},fetchImpl:async input=>{const url=new URL(String(input));if(url.pathname==='/mcp')return json({},401,{'WWW-Authenticate':'Bearer resource_metadata="https://music.example.test/.well-known/oauth-protected-resource/mcp"'});if(url.pathname.includes('oauth-protected-resource'))return json({resource:config.url,authorization_servers:[issuer]});if(url.pathname.includes('.well-known'))return json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']});if(url.pathname==='/token'){tokenRequests++;return new Response(tokenResponse,{status:200,headers:{'Content-Type':'application/json'}});}throw Error('Unexpected fixture route');}});
  console.warn=(...args)=>logs.push(args.map(String).join(' '));try{await assert.rejects(client.connect());assert.ok(tokenRequests>0);assert.doesNotMatch(logs.join('\n'),/SYNTHETIC-SECRET-MARKER/);}finally{console.warn=warn;await client.close();}
 }
});
function anonymousFixture(onMessage){return new RemoteMcpClient(config,{authStore:{available(){},read(){return {};},async write(){}},approve:async()=>{throw Error('Unexpected authorization');},openExternal:()=>{throw Error('Unexpected browser');},fetchImpl:async(_input,options={})=>{if(options.method==='GET')return new Response(null,{status:405});const message=JSON.parse(options.body||'{}');if(message.id===undefined)return new Response(null,{status:202});const result=message.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Synthetic fixture',version:'1'}}:await onMessage(message,options);return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'Content-Type':'application/json'}});}});}
test('real SDK pagination enforces tool count and empty-page limits before aggregation continues',async()=>{
 for(const empty of [false,true]){let pages=0;const client=anonymousFixture(()=>{pages++;return {tools:empty?[]:Array.from({length:200},(_,i)=>({name:`tool_${pages}_${i}`,inputSchema:{type:'object'}})),nextCursor:String(pages)};});try{await client.connect();await assert.rejects(client.listTools(),/exceeds 20 pages, 500 tools|exceeds 20 pages/);assert.equal(pages,empty?20:3);}finally{await client.close();}}
});
test('real SDK cancellation reaches the active HTTP tool request without reconnecting or automatic retry',async()=>{
 let entered,seenSignal,calls=0;const ready=new Promise(resolve=>entered=resolve),controller=new AbortController();const client=anonymousFixture(async(message,options)=>{if(message.method==='tools/list')return {tools:[{name:'echo',inputSchema:{type:'object'}}]};calls++;seenSignal=options.signal;entered();await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('Synthetic network abort')),{once:true}));});try{await client.connect();await client.listTools();const pending=client.request('tools/call',{name:'echo',arguments:{}},{signal:controller.signal}),rejected=assert.rejects(pending,/cancelled.*effect is unknown/);await ready;controller.abort();await rejected;assert.equal(seenSignal.aborted,true);assert.equal(calls,1);assert.equal(client.dead,false);}finally{await client.close();}
});
test('OAuth consent timing, displayed scopes and callback issuer use actual SDK safeguards',async t=>{
 const f=await store(t),remote=fixtureRemote({scope:'music:read\nFORGED LINE'});let approvals=0,opened=0;
 const client=new RemoteMcpClient(config,{authStore:f.result,...remote,timeoutMs:1000,approve:async request=>{approvals++;assert.doesNotMatch(request.detail,/\nFORGED LINE/);await new Promise(resolve=>setTimeout(resolve,40));return true;},openExternal:async url=>{opened++;await remote.openExternal(url);}});try{await client.connect();assert.equal(approvals,1);assert.equal(opened,1);}finally{await client.close();}
 const other=await store(t),mismatch=fixtureRemote({callbackIssuer:'https://wrong.example.test'}),wrong=new RemoteMcpClient(config,{authStore:other.result,...mismatch});await assert.rejects(wrong.connect());assert.equal(mismatch.requests.some(request=>request.url.endsWith('/token')),false);
});
test('human approval may outlast the SDK handshake timeout without expiring the subsequent browser sign-in',async t=>{
 const f=await store(t),remote=fixtureRemote();let opened=0;
 const client=new RemoteMcpClient(config,{authStore:f.result,...remote,timeoutMs:250,oauthTimeoutMs:100,approve:async()=>{await new Promise(resolve=>setTimeout(resolve,350));return true;},openExternal:async url=>{opened++;await remote.openExternal(url);}});try{await client.connect();assert.equal(opened,1);assert.equal(f.result.read(config.url).tokens.access_token,'synthetic-access');}finally{await client.close();}
});
test('expired authorization gives fresh-link guidance; reconnect rejects the old state and completes new sign-in',async t=>{
 const f=await store(t),remote=fixtureRemote();let oldAuthorization;
 const timed=new RemoteMcpClient(config,{authStore:f.result,...remote,oauthTimeoutMs:30,openExternal:async url=>{oldAuthorization=new URL(url);}});await assert.rejects(timed.connect(),/sign-in expired.*Connect again.*fresh authorization page/);assert.equal(timed.dead,true);assert.equal(remote.requests.some(request=>request.url.endsWith('/token')),false);assert.equal(f.result.read(config.url).tokens,undefined);
 const retry=fixtureRemote(),client=new RemoteMcpClient(config,{authStore:f.result,...retry,openExternal:async url=>{const authorization=new URL(url);assert.notEqual(authorization.searchParams.get('state'),oldAuthorization.searchParams.get('state'));assert.equal(authorization.searchParams.get('redirect_uri'),oldAuthorization.searchParams.get('redirect_uri'));const stale=new URL(oldAuthorization.searchParams.get('redirect_uri'));stale.searchParams.set('state',oldAuthorization.searchParams.get('state'));stale.searchParams.set('code','stale-code');assert.equal((await fetch(stale)).status,400);await retry.openExternal(url);}});try{await client.connect();assert.equal((await client.listTools())[0].name,'echo');assert.equal(retry.requests.filter(request=>request.url.endsWith('/token')).length,1);}finally{await client.close();}
});
test('token exchange has a wall-clock deadline and cancellation settles even when the response ignores abort',async t=>{
 for(const mode of ['timeout','cancel']){
  const f=await store(t),remote=fixtureRemote();let entered,release,finished,tokenSignal,tokenWrites=0;
  const ready=new Promise(resolve=>entered=resolve),delayed=new Promise(resolve=>release=resolve),sdkFinished=new Promise(resolve=>finished=resolve),write=f.result.write.bind(f.result);
  f.result.write=async(url,value)=>{if(value.tokens)tokenWrites++;return write(url,value);};
  const client=new RemoteMcpClient(config,{authStore:f.result,...remote,timeoutMs:250,fetchImpl:async(input,options)=>{const response=await remote.fetchImpl(input,options);if(new URL(String(input)).pathname==='/token'){tokenSignal=options.signal;entered();await delayed;}return response;},openExternal:async url=>{const finish=client.transport.finishAuth.bind(client.transport);client.transport.finishAuth=async response=>{try{return await finish(response);}finally{finished();}};await remote.openExternal(url);}});
  const connecting=client.connect(),rejected=assert.rejects(connecting,mode==='timeout'?/timed out while completing authorization.*Connect again/:/cancelled|changed/);
  await ready;if(mode==='cancel')await client.close();let guard;try{await Promise.race([rejected,new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('Token exchange did not settle within its deadline')),1500);})]);}finally{clearTimeout(guard);}
  assert.equal(client.dead,true);assert.equal(tokenSignal.aborted,true);assert.equal(tokenWrites,0);assert.equal(f.result.read(config.url).tokens,undefined);
  release();await sdkFinished;assert.equal(tokenWrites,0);assert.equal(f.result.read(config.url).tokens,undefined);
 }
});
test('saved callback conflicts and missing addresses fail with actionable local errors',async()=>{
 const busy=await oauthLoopback({state:'busy-fixture'});try{for(const saved of [{client:{client_id:'fixture'}},{client:{client_id:'fixture'},redirectUrl:busy.redirectUrl}]){const client=new RemoteMcpClient(config,{authStore:{available(){},read:()=>saved},fetchImpl:()=>{throw Error('Network must not run');}});await assert.rejects(client.connect(),/callback address/);await client.close();}}finally{busy.close();}
});
test('all checked public DNS addresses support dual-stack fallback and duplicate remote endpoints are refused',async()=>{
 const addresses=[{address:'2606:4700::1111',family:6},{address:'8.8.8.8',family:4}];let resolved;
 const requestImpl=(_url,options,callback)=>{assert.equal(options.autoSelectFamily,true);options.lookup('ignored',{all:true},(_error,value)=>resolved=value);const request=new EventEmitter();request.setTimeout=ms=>assert.equal(ms,90000);request.end=()=>{const response=new PassThrough();response.statusCode=204;response.headers={};callback(response);response.end();};return request;};await createRemoteFetch({lookupImpl:async()=>addresses,requestImpl})(config.url);assert.deepEqual(resolved,addresses);
 const tools=new ExternalMcpTools({getSettings:()=>({externalMcpServers:[config,{...config,id:'duplicate'}]}),approve:()=>{throw Error('Approval must not run');}});await assert.rejects(tools.refresh(),/one connection per remote MCP address/);
});
test('equivalent canonical endpoint addresses do not misclassify MCP success as OAuth JSON',async()=>{
 const client=anonymousFixture(()=>({tools:[{name:'echo',inputSchema:{type:'object'}}]}));client.config={...config,url:'https://MUSIC.example.test/mcp'};try{await client.connect();assert.equal((await client.listTools()).length,1);}finally{await client.close();}
});
