import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomInt} from 'node:crypto';
import {DISCORD_CONTROLS,DISCORD_TASK_HELP} from './discord-tasks.mjs';
import {encryptProtectedSecret,decryptProtectedSecret} from './secret-storage.mjs';

/** Exomina in Telegram and Discord: private bots that only answer accounts the
 * user paired with a one-time code. Each conversation there is a normal Exomina
 * chat (same memory, continued on the desktop). Discord supports local tasks
 * and authenticated phone approvals; Telegram keeps its chat-only scope.
 * Both bridges poll or connect from this PC; nothing is hosted.
 * WhatsApp is not offered: its official API needs Meta business verification
 * and a public webhook, and unofficial clients break WhatsApp's terms.
 */
export const CHANNELS=['telegram','discord'];
const LIMIT={telegram:4000,discord:1900};
export const CHANNEL_TOOLS=/^(memory_|archive_|conversation_(find|search|read|zoom|date)$|followup_update$|personalization_update$|soul_reflect$|app_update_status$)/;
const wait=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new Error('Connection stopped.'));
  const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(finish,ms),abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('Connection stopped.'));};
  signal?.addEventListener('abort',abort,{once:true});
});
const safeError=(error,token)=>String(error?.message||error).replaceAll(token,'[bot token]').slice(0,500);

/** Splits a reply at paragraph, line or word boundaries within a platform's message limit. */
export function chunk(text,limit){
  const out=[];let rest=String(text||'').trim();
  while(rest.length>limit){
    let cut=rest.lastIndexOf('\n\n',limit);if(cut<limit*0.5)cut=rest.lastIndexOf('\n',limit);if(cut<limit*0.5)cut=rest.lastIndexOf(' ',limit);if(cut<limit*0.3)cut=limit;
    out.push(rest.slice(0,cut).trim());rest=rest.slice(cut).trim();
  }
  if(rest)out.push(rest);return out;
}

export class TelegramBridge{
  constructor({token,onMessage,onStatus,fetchImpl=fetch,delayImpl=wait}){Object.assign(this,{token,onMessage,onStatus,fetch:fetchImpl,pause:delayImpl});this.offset=0;this.running=false;this.controller=new AbortController();}
  async call(method,body,signal){
    for(let attempt=0;attempt<3;attempt++){
      const requestSignal=AbortSignal.any([this.controller.signal,...(signal?[signal]:[]),AbortSignal.timeout(method==='getUpdates'?60000:15000)]);
      let response;try{response=await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{}),signal:requestSignal});}catch(error){throw new Error(safeError(error,this.token));}
      const data=await response.json().catch(()=>({}));
      if((data.error_code||response.status)===429&&attempt<2){await this.pause(Math.min(60000,Math.max(1000,(Number(data.parameters?.retry_after)||1)*1000)),requestSignal);continue;}
      if(!data.ok){const error=new Error(safeError(new Error(data.description||`Telegram error ${response.status}`),this.token));error.status=data.error_code||response.status;throw error;}
      return data.result;
    }
  }
  async start(){
    const me=await this.call('getMe');this.controller.signal.throwIfAborted();this.username=me.username;this.running=true;this.onStatus?.({state:'connected',name:`@${me.username}`});
    (async()=>{let backoff=1000;
      while(this.running){
        try{
          const updates=await this.call('getUpdates',{offset:this.offset,timeout:45,allowed_updates:['message']});if(!this.running)break;backoff=1000;
          this.onStatus?.({state:'connected',name:`@${this.username}`});
          for(const update of updates){this.offset=update.update_id+1;const message=update.message;if(message?.chat?.type!=='private'||!message.text||message.from?.is_bot||message.from?.id==null)continue;
            this.onMessage({channel:'telegram',chatKey:String(message.chat.id),userId:String(message.from.id),name:[message.from.first_name,message.from.last_name].filter(Boolean).join(' ')||message.from.username||'Telegram user',text:message.text});}
        }catch(error){
          if(!this.running)break;
          if(error.status===401){this.running=false;this.onStatus?.({state:'error',error:'Telegram rejected the bot token. Create a new one with @BotFather.'});break;}
          this.onStatus?.({state:'retrying',error:error.status===409?'Another program is reading this bot’s messages. Close it, or use a separate bot for Exomina.':`Telegram unreachable: ${safeError(error,this.token)}`});
          try{await this.pause(backoff,this.controller.signal);}catch{break;}backoff=Math.min(backoff*2,60000);
        }
      }
    })();
    return {name:`@${me.username}`};
  }
  stop(){this.running=false;this.controller?.abort();}
  async send(chatKey,text,{signal}={}){for(const part of chunk(text,LIMIT.telegram)){signal?.throwIfAborted();await this.call('sendMessage',{chat_id:chatKey,text:part,link_preview_options:{is_disabled:true}},signal);}}
  typing(chatKey){return this.call('sendChatAction',{chat_id:chatKey,action:'typing'}).catch(()=>{});}
}

export class DiscordBridge{
  constructor({token,onMessage,onStatus,fetchImpl=fetch,WebSocketImpl=globalThis.WebSocket,delayImpl=wait,reconnectDelay=5000,gatewayTimeout=15000}){Object.assign(this,{token,onMessage,onStatus,fetch:fetchImpl,WebSocket:WebSocketImpl,pause:delayImpl,reconnectDelay,gatewayTimeout});this.running=false;this.seq=null;this.controller=new AbortController();this.seenMessages=new Set();}
  async rest(route,body,method=body?'POST':'GET',signal){
    for(let attempt=0;attempt<3;attempt++){
      let response;try{response=await this.fetch(`https://discord.com/api/v10${route}`,{method,headers:{Authorization:`Bot ${this.token}`,'Content-Type':'application/json','User-Agent':'DiscordBot (https://exomina.local, 1.0) Exomina'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([this.controller.signal,...(signal?[signal]:[]),AbortSignal.timeout(15000)])});}catch(error){throw new Error(safeError(error,this.token));}
      const data=response.status===204?{}:await response.json().catch(()=>({}));
      if(response.status===429&&attempt<2){await this.pause(Math.min(60000,Math.max(1000,(Number(data.retry_after)||1)*1000)),signal?AbortSignal.any([this.controller.signal,signal]):this.controller.signal);continue;}
      if(!response.ok){const error=new Error(safeError(new Error(data.message||`Discord error ${response.status}`),this.token));error.status=response.status;throw error;}
      return data;
    }
  }
  async start(){
    if(!this.WebSocket)throw new Error('This Exomina build has no WebSocket support for Discord.');
    const me=await this.rest('/users/@me');this.controller.signal.throwIfAborted();this.me=me;this.running=true;
    this.inviteUrl=`https://discord.com/oauth2/authorize?client_id=${me.id}&scope=bot&permissions=3072`;
    this.connect();
    return {state:'connecting',name:me.username,inviteUrl:this.inviteUrl};
  }
  connect(){
    if(!this.running)return;
    const address=new URL(this.resumeUrl||'wss://gateway.discord.gg/');address.searchParams.set('v','10');address.searchParams.set('encoding','json');
    const socket=new this.WebSocket(address.href);this.socket=socket;
    const reconnect=()=>{clearTimeout(this.closeTimer);this.closeTimer=setTimeout(()=>{if(this.socket===socket&&this.running)socket.onclose?.({code:4000});},5000);this.closeTimer.unref?.();try{socket.close(4000);}catch{socket.onclose?.({code:4000});}};
    let heartbeatAcknowledged=true;
    const heartbeat=()=>{if(socket.readyState!==1)return;if(!heartbeatAcknowledged){reconnect();return;}heartbeatAcknowledged=false;socket.send(JSON.stringify({op:1,d:this.seq}));};
    this.gatewayTimer=setTimeout(()=>{if(this.socket===socket&&this.running){this.onStatus?.({state:'retrying',error:'Discord did not finish connecting. Retrying…'});reconnect();}},this.gatewayTimeout);this.gatewayTimer.unref?.();
    socket.onmessage=event=>{
      if(!this.running||this.socket!==socket)return;
      let packet;try{packet=JSON.parse(String(event.data));}catch{return;}
      if(packet.s!==null&&packet.s!==undefined)this.seq=packet.s;
      if(packet.op===10){
        const interval=Number(packet.d?.heartbeat_interval);if(!Number.isFinite(interval)||interval<1){reconnect();return;}
        clearInterval(this.heartbeat);this.heartbeat=setInterval(heartbeat,interval);this.heartbeat.unref?.();
        // Direct messages only (intent 1<<12); their content needs no privileged intent.
        socket.send(JSON.stringify(this.sessionId&&this.seq!==null?{op:6,d:{token:this.token,session_id:this.sessionId,seq:this.seq}}:{op:2,d:{token:this.token,intents:1<<12,properties:{os:'windows',browser:'exomina',device:'exomina'}}}));
      }else if(packet.op===11)heartbeatAcknowledged=true;
      else if(packet.op===1){heartbeatAcknowledged=true;heartbeat();}
      else if(packet.op===0&&['READY','RESUMED'].includes(packet.t)){
        if(packet.t==='READY'){this.sessionId=packet.d?.session_id||null;try{const url=new URL(packet.d?.resume_gateway_url);this.resumeUrl=url.protocol==='wss:'&&(url.hostname==='gateway.discord.gg'||url.hostname.endsWith('.discord.gg'))&&!url.username&&!url.password?url.href:null;}catch{this.resumeUrl=null;}}
        clearTimeout(this.gatewayTimer);this.reconnectAttempt=0;this.onStatus?.({state:'connected',name:this.me.username,inviteUrl:this.inviteUrl});
      }
      else if(packet.op===0&&packet.t==='MESSAGE_CREATE'){const message=packet.d;if(!message?.author?.id||message.guild_id||message.author.bot||!message.content)return;
        if(message.id){if(this.seenMessages.has(message.id))return;this.seenMessages.add(message.id);if(this.seenMessages.size>1000)this.seenMessages.delete(this.seenMessages.values().next().value);}
        this.onMessage({channel:'discord',chatKey:message.channel_id,userId:message.author.id,name:message.author.global_name||message.author.username||'Discord user',text:message.content});}
      else if(packet.op===7||packet.op===9){if(packet.op===9&&!packet.d){this.sessionId=null;this.resumeUrl=null;this.seq=null;}reconnect();}
    };
    socket.onclose=event=>{
      if(this.socket!==socket)return;this.socket=null;clearInterval(this.heartbeat);clearTimeout(this.gatewayTimer);clearTimeout(this.closeTimer);if(!this.running)return;
      if([4004,4010,4011,4012,4013,4014].includes(event.code)){this.running=false;this.onStatus?.({state:'error',error:event.code===4004?'Discord rejected the bot token. Reset it in the Developer Portal.':`Discord closed the connection (${event.code}).`});return;}
      if([4007,4009].includes(event.code)){this.sessionId=null;this.resumeUrl=null;this.seq=null;}
      const attempt=this.reconnectAttempt||0;this.reconnectAttempt=attempt+1;const delay=Math.min(60000,this.reconnectDelay*2**Math.min(attempt,6));this.onStatus?.({state:'retrying',error:'Reconnecting to Discord…'});clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>this.connect(),delay);this.reconnectTimer.unref?.();
    };
    socket.onerror=()=>{};
  }
  stop(){this.running=false;this.controller.abort();clearInterval(this.heartbeat);clearTimeout(this.gatewayTimer);clearTimeout(this.reconnectTimer);clearTimeout(this.closeTimer);try{this.socket?.close(1000);}catch{}}
  async send(chatKey,text,{signal}={}){for(const part of chunk(text,LIMIT.discord)){signal?.throwIfAborted();await this.rest(`/channels/${chatKey}/messages`,{content:part,allowed_mentions:{parse:[]}},'POST',signal);}}
  typing(chatKey){return this.rest(`/channels/${chatKey}/typing`,{}).catch(()=>{});}
}

const HELP='Exomina, from your phone.\n\nJust write to chat. Commands:\n/new starts a fresh chat\n/ai claude (or chatgpt, gemini, …) switches who answers\n/usage shows remaining subscription usage\n/help shows this.\n\nThis chat shares memory with Exomina on your PC. Files, browser and desktop tools stay on the PC.';

/** Pairing, routing and replies for all bridges. `chat` runs a message in an Exomina chat and resolves with the reply. */
export class MessagingHub{
  constructor({dataDir,encryption,getSettings,saveSettings,chat,usageText,providerFor,tasks,emit=()=>{},Bridges={telegram:TelegramBridge,discord:DiscordBridge},pairingTtl=15*60*1000}){
    Object.assign(this,{file:path.join(dataDir,'messaging-tokens.json'),encryption,getSettings,saveSettings,chat,usageText,providerFor,tasks,emit,Bridges,pairingTtl});tasks?.attach(this);
    this.bridges=new Map();this.status={};this.codes=new Map();this.codeTimers=new Map();this.chains=new Map();this.warned=new Set();this.generations=new Map();this.userVersions=new Map();this.revoking=new Set();this.turns=new Map();this.queueVersions=new Map();this.queueCounts=new Map();this.controlChains=new Map();this.sendChains=new Map();this.tasksDisabled=false;this.configWrites=Promise.resolve();this.tokenWrites=Promise.resolve();
  }
  assertChannel(channel){if(!CHANNELS.includes(channel))throw new Error('Unknown messaging channel.');}
  config(channel){const value=this.getSettings().messaging?.[channel]||{};return {enabled:value.enabled===true,taskExecution:channel==='discord'&&value.taskExecution!==false,paired:Array.isArray(value.paired)?value.paired:[],provider:value.provider||'',links:value.links&&typeof value.links==='object'?value.links:{}};}
  taskIdentity(origin){
    if(origin?.type!=='discord'||!this.tasks||this.tasksDisabled||!this.config('discord').taskExecution||!this.config('discord').enabled||!this.bridges.has('discord'))return null;
    const user=this.config('discord').paired.find(p=>p.id===origin.userId&&p.chatKey===origin.chatKey);if(!user||this.revoking.has('discord:'+user.id))return null;
    return {channel:'discord',chatKey:user.chatKey,userId:user.id,generation:this.generations.get('discord'),userVersion:this.userVersions.get('discord:'+user.id)||0};
  }
  currentIdentity(identity){const live=this.taskIdentity({type:'discord',...identity});return !!live&&live.generation===identity.generation&&live.userVersion===identity.userVersion;}
  canExecute(origin){return !!this.taskIdentity(origin);}
  sendTask(identity,text){const key=identity.chatKey,next=(this.sendChains.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{if(!this.currentIdentity(identity))throw Error('Discord access was revoked.');const bridge=this.bridges.get('discord');for(const part of (Array.isArray(text)?text:chunk(text,LIMIT.discord))){if(!this.currentIdentity(identity))throw Error('Discord access was revoked.');await bridge.send(identity.chatKey,part);}});this.sendChains.set(key,next);next.finally(()=>{if(this.sendChains.get(key)===next)this.sendChains.delete(key);}).catch(()=>{});return next;}
  taskMode(identity){return this.config('discord').paired.find(p=>p.id===identity.userId)?.taskMode||'ask';}
  taskProject(identity){return this.config('discord').paired.find(p=>p.id===identity.userId)?.projectId||'';}
  async setPairedTaskMode(userId,mode){
    if(!['ask','auto-edit','full','read-only'].includes(mode))throw Error('Choose a valid access level.');
    const user=this.config('discord').paired.find(p=>p.id===userId);if(!user)throw Error('This Discord account is no longer paired.');
    this.stopUser({channel:'discord',userId});
    await this.setConfig('discord',config=>{if(!config.paired.some(p=>p.id===userId))throw Error('This account is no longer paired.');return {paired:config.paired.map(p=>p.id===userId?{...p,taskMode:mode}:p)};});
    const chat=this.tasks?.getChat(this.config('discord').links[user.chatKey]);
    if(chat?.channel?.type==='discord'&&chat.channel.userId===userId&&chat.channel.chatKey===user.chatKey)await this.tasks.setMode(chat,mode);
    this.emit({type:'messaging.status',status:this.view()});return this.view();
  }
  async setTaskMode(identity,mode){await this.setConfig('discord',config=>{if(!this.currentIdentity(identity))throw Error('Discord access was revoked.');return {paired:config.paired.map(p=>p.id===identity.userId?{...p,taskMode:mode}:p)};});}
  async setTaskProject(identity,projectId){await this.setConfig('discord',config=>{if(!this.currentIdentity(identity))throw Error('Discord access was revoked.');const links={...config.links};delete links[identity.chatKey];return {links,paired:config.paired.map(p=>p.id===identity.userId?{...p,projectId}:p)};});}
  async clearTaskChat(identity){await this.setConfig('discord',config=>{if(!this.currentIdentity(identity))throw Error('Discord access was revoked.');const links={...config.links};delete links[identity.chatKey];return {links};});}
  stopUser(identity){const key=identity.channel+':'+identity.userId;this.queueVersions.set(key,(this.queueVersions.get(key)||0)+1);for(const controller of this.turns.get(key)||[])controller.abort();const user=this.config(identity.channel).paired.find(p=>p.id===identity.userId),id=user&&this.config(identity.channel).links[user.chatKey];if(id)this.tasks?.stop(id);}
  queued(identity){return Math.max(0,(this.queueCounts.get(identity.channel+':'+identity.chatKey)||0)-1);}
  async setTaskExecution(enabled){if(typeof enabled!=='boolean')throw Error('Choose whether Discord can run tasks.');const previous=this.tasksDisabled;this.tasksDisabled=!enabled;if(!enabled)for(const p of this.config('discord').paired)this.stopUser({channel:'discord',userId:p.id});try{await this.setConfig('discord',{taskExecution:enabled});}catch(error){this.tasksDisabled=previous;throw error;}this.emit({type:'messaging.status',status:this.view()});return this.view();}
  async setConfig(channel,patch){this.assertChannel(channel);const write=this.configWrites.catch(()=>{}).then(async()=>{const all=this.getSettings().messaging||{},config=this.config(channel),next=typeof patch==='function'?patch(config):patch;if(!next)return;await this.saveSettings({messaging:{...all,[channel]:{...config,...next}}});});this.configWrites=write;return write;}
  async tokens(){try{return JSON.parse(await readFile(this.file,'utf8'));}catch{return {};}}
  async token(channel){const saved=(await this.tokens())[channel];return saved?decryptProtectedSecret(this.encryption,Buffer.from(saved,'base64')):null;}
  async saveToken(channel,token){this.assertChannel(channel);const write=this.tokenWrites.catch(()=>{}).then(async()=>{const all=await this.tokens();if(token)all[channel]=encryptProtectedSecret(this.encryption,token).toString('base64');else delete all[channel];await writeFile(this.file+'.tmp',JSON.stringify(all),{mode:0o600});await rename(this.file+'.tmp',this.file);});this.tokenWrites=write;return write;}
  setStatus(channel,value){this.status[channel]={...value,at:new Date().toISOString()};this.emit({type:'messaging.status',status:this.view()});}
  view(){return Object.fromEntries(CHANNELS.map(channel=>{const config=this.config(channel);const code=this.codes.get(channel);return [channel,{...config,recipients:this.recipients(channel),links:undefined,chats:Object.keys(config.links).length,...(this.status[channel]||{state:config.enabled?'stopped':'off'}),code:code&&code.expires>Date.now()?code.value:null}];}));}
  async startAll(){for(const channel of CHANNELS)if(this.config(channel).enabled)await this.start(channel).catch(error=>this.setStatus(channel,{state:'error',error:error.message}));}
  async start(channel){
    this.assertChannel(channel);this.stop(channel);const generation=this.generations.get(channel),token=await this.token(channel);if(this.generations.get(channel)!==generation)throw new Error('Connection stopped.');if(!token)throw new Error('Add the bot token first.');
    return this.open(channel,token,generation);
  }
  async open(channel,token,generation,persist=false){
    let bridge;const current=()=>this.generations.get(channel)===generation&&this.bridges.get(channel)===bridge;
    bridge=new this.Bridges[channel]({token,onMessage:message=>{if(current())this.receive({...message,generation});},onStatus:value=>{if(current())this.setStatus(channel,value);}});
    this.bridges.set(channel,bridge);this.setStatus(channel,{state:'connecting'});
    try{
      const info=await bridge.start();if(!current())throw new Error('Connection stopped.');
      if(persist){await this.saveToken(channel,token);await this.setConfig(channel,{enabled:true});}
      if(!current())throw new Error('Connection stopped.');
      const latest=this.status[channel];this.setStatus(channel,{...info,...latest,state:latest?.state==='connecting'?info.state||'connected':latest?.state||info.state||'connected'});
      if(persist)this.newCode(channel);return info;
    }catch(error){bridge.stop();if(current()){this.bridges.delete(channel);this.setStatus(channel,{state:'error',error:error.status===401?'The bot token was rejected.':safeError(error,token)});}throw Object.assign(new Error(error.status===401?'The bot token was rejected.':safeError(error,token)),/^SECRET_STORAGE_[A-Z_]+$/.test(error.code||'')?{code:error.code}:{});}
  }
  clearCode(channel){this.codes.delete(channel);clearTimeout(this.codeTimers.get(channel));this.codeTimers.delete(channel);}
  stop(channel){this.generations.set(channel,(this.generations.get(channel)||0)+1);this.clearCode(channel);for(const [key,turns] of this.turns)if(key.startsWith(channel+':'))for(const controller of turns)controller.abort();this.bridges.get(channel)?.stop();this.bridges.delete(channel);}
  stopAll(){for(const channel of [...this.bridges.keys()])this.stop(channel);}
  async connect(channel,token){
    this.assertChannel(channel);
    if(typeof token!=='string'||!/^[\w.:-]{20,200}$/.test(token.trim()))throw new Error(channel==='telegram'?'Paste the token @BotFather gave you (it looks like 123456:ABC…).':'Paste the bot token from the Discord Developer Portal.');
    const hadPrevious=this.config(channel).enabled;this.stop(channel);const generation=this.generations.get(channel);
    try{return await this.open(channel,token.trim(),generation,true);}catch(error){
      if(hadPrevious&&this.generations.get(channel)===generation){let restored=false;try{await this.start(channel);restored=true;}catch{}if(restored)throw new Error(error.message+' The saved token is still in use; the previous bot is reconnecting.');}
      throw error;
    }
  }
  async disconnect(channel){this.assertChannel(channel);this.stop(channel);await this.saveToken(channel,null);await this.setConfig(channel,{enabled:false,paired:[],links:{}});this.setStatus(channel,{state:'off'});}
  newCode(channel){this.assertChannel(channel);if(!this.config(channel).enabled||!this.bridges.has(channel))throw new Error('Connect the bot before pairing an account.');this.clearCode(channel);const value=String(randomInt(100000,1000000)),record={value,expires:Date.now()+this.pairingTtl,misses:0};this.codes.set(channel,record);const timer=setTimeout(()=>{if(this.codes.get(channel)===record){this.clearCode(channel);this.emit({type:'messaging.status',status:this.view()});}},this.pairingTtl);timer.unref?.();this.codeTimers.set(channel,timer);this.emit({type:'messaging.status',status:this.view()});return value;}
  async unpair(channel,userId){this.assertChannel(channel);const key=channel+':'+userId;this.userVersions.set(key,(this.userVersions.get(key)||0)+1);this.revoking.add(key);this.stopUser({channel,userId});try{await this.setConfig(channel,config=>{const removed=config.paired.find(item=>item.id===userId),links={...config.links};if(removed?.chatKey)delete links[removed.chatKey];return{paired:config.paired.filter(item=>item.id!==userId),links};});this.emit({type:'messaging.status',status:this.view()});}finally{this.revoking.delete(key);}}
  recipients(channel){const config=this.config(channel);return config.paired.map(p=>({chatKey:p.chatKey||(channel==='telegram'&&config.links[p.id]?p.id:''),name:p.name||p.id})).filter(p=>p.chatKey);}
  async sendScheduled(channel,chatKey,text){const bridge=this.bridges.get(channel);if(!bridge||!this.recipients(channel).some(r=>r.chatKey===chatKey))throw Error('This messaging recipient is no longer paired or the bot is disconnected.');await bridge.send(chatKey,text);}
  /** Messages from one chat are answered in order. */
  receive(message){
    const key=`${message.channel}:${message.chatKey}`,userKey=message.channel+':'+message.userId,generation=message.generation??this.generations.get(message.channel),userVersion=this.userVersions.get(userKey)||0,queueVersion=this.queueVersions.get(userKey)||0;
    const input={...message,generation,userVersion};
    // Approval, question and stop responses must run while the model is waiting.
    if(message.channel==='discord'&&DISCORD_CONTROLS.test(String(message.text).trim())&&this.config('discord').paired.some(p=>p.id===message.userId&&p.chatKey===message.chatKey)){
      const previous=this.controlChains.get(key)||Promise.resolve(),next=previous.catch(()=>{}).then(async()=>{await this.handle(input);return this.queueVersions.get(userKey)||0;}).catch(()=>this.queueVersions.get(userKey)||0);this.controlChains.set(key,next);next.finally(()=>{if(this.controlChains.get(key)===next)this.controlChains.delete(key);});return next;
    }
    const controls=this.controlChains.get(key);this.queueCounts.set(key,(this.queueCounts.get(key)||0)+1);
    const next=(this.chains.get(key)||Promise.resolve()).then(async()=>{const acceptedVersion=controls?await controls:queueVersion;if((this.queueVersions.get(userKey)||0)===acceptedVersion)await this.handle(input);}).catch(()=>{});
    this.chains.set(key,next);next.then(()=>{this.queueCounts.set(key,Math.max(0,(this.queueCounts.get(key)||1)-1));if(this.chains.get(key)===next)this.chains.delete(key);});return next;
  }
  async handle({channel,chatKey,userId,name,text,generation,userVersion}){
    const bridge=this.bridges.get(channel),userKey=channel+':'+userId,current=()=>this.bridges.get(channel)===bridge&&this.generations.get(channel)===generation&&(this.userVersions.get(userKey)||0)===userVersion&&!this.revoking.has(userKey);
    if(!bridge||!current()||typeof text!=='string')return;
    const authorized=()=>current()&&this.config(channel).paired.some(item=>item.id===userId&&item.chatKey===chatKey);
    const config=this.config(channel),body=text.trim(),code=this.codes.get(channel);
    const pairing=/^\/(?:pair|start)\s+(\d{6})\b/.exec(body);
    if(!config.paired.some(item=>item.id===userId)){
      if(pairing&&code&&code.expires>Date.now()&&pairing[1]===code.value){
        this.clearCode(channel);let paired=false;await this.setConfig(channel,live=>{if(!current()||!live.enabled||live.paired.length>=5)return null;paired=true;return{paired:[...live.paired,{id:userId,chatKey,name:String(name).slice(0,80),pairedAt:new Date().toISOString()}]};});
        this.emit({type:'messaging.status',status:this.view()});if(!current())return;await bridge.send(chatKey,paired?`Paired. Hi ${name}!\n\n${HELP}${channel==='discord'&&this.tasks?DISCORD_TASK_HELP:''}`:'Five accounts are already paired. Remove an account in Settings → Messaging before pairing another.');return;
      }
      if(pairing&&code&&code.expires>Date.now()&&++code.misses>=5){this.clearCode(channel);this.emit({type:'messaging.status',status:this.view()});}
      // Strangers get one short answer and then silence.
      if(!this.warned.has(`${channel}:${userId}`)){if(this.warned.size>=500)this.warned.delete(this.warned.values().next().value);this.warned.add(`${channel}:${userId}`);await bridge.send(chatKey,'This is a private Exomina bot. To use it, open Exomina on your PC → Settings → Messaging and send the pairing code shown there as: /pair 123456').catch(()=>{});}
      return;
    }
    if(config.paired.some(p=>p.id===userId&&p.chatKey!==chatKey))await this.setConfig(channel,live=>current()&&live.paired.some(p=>p.id===userId)?{paired:live.paired.map(p=>p.id===userId?{...p,chatKey}:p)}:null);
    if(!authorized())return;
    const identity={channel,chatKey,userId,generation,userVersion};
    if(channel==='discord'&&this.canExecute({type:channel,chatKey,userId})&&DISCORD_CONTROLS.test(body)){
      try{const answer=await this.tasks.command(identity,body,config.links[chatKey]);if(authorized())await this.sendTask(identity,answer);}catch(error){if(authorized())await bridge.send(chatKey,'Task control: '+safeError(error,bridge.token||'unused-token'));}return;
    }
    if(/^\/(help|start)\b/.test(body))return bridge.send(chatKey,HELP+(channel==='discord'&&this.tasks?DISCORD_TASK_HELP:''));
    if(/^\/new\b/.test(body)){await this.setConfig(channel,live=>{if(!authorized())return null;const links={...live.links};delete links[chatKey];return{links};});if(authorized())return bridge.send(chatKey,'Started a fresh chat. What’s next?');return;}
    if(/^\/usage\b/.test(body))return bridge.send(chatKey,this.usageText()||'No usage has been reported yet. It appears after the first reply from Claude or ChatGPT.');
    const ai=/^\/ai\s+(\S+)/.exec(body);
    if(ai){const provider=this.providerFor(ai[1]);if(!provider)return bridge.send(chatKey,'I don’t know that AI, or it isn’t connected in Exomina. Try /ai claude or /ai chatgpt.');await this.setConfig(channel,{provider:provider.id});return bridge.send(chatKey,`${provider.name} answers from now on.`);}
    if(body.startsWith('/'))return bridge.send(chatKey,HELP);
    const controller=new AbortController(),turnVersion=this.queueVersions.get(userKey)||0,turnAuthorized=()=>authorized()&&!controller.signal.aborted&&(this.queueVersions.get(userKey)||0)===turnVersion,turns=this.turns.get(userKey)||new Set();turns.add(controller);this.turns.set(userKey,turns);
    const typing=setInterval(()=>{if(authorized())bridge.typing(chatKey);},channel==='discord'?8000:4500);bridge.typing(chatKey);
    try{
      const task=channel==='discord'&&this.canExecute({type:channel,chatKey,userId});
      const result=await this.chat({channel,chatKey,name,text:body,conversationId:config.links[chatKey],provider:config.provider||undefined,signal:controller.signal,...(task?{userId,permissionMode:this.taskMode(identity),projectId:this.taskProject(identity),onStarted:async id=>{await this.setConfig(channel,live=>turnAuthorized()?{links:{...live.links,[chatKey]:id}}:null);}}:{})});
      if(!turnAuthorized())return;
      if(result.conversationId&&config.links[chatKey]!==result.conversationId)await this.setConfig(channel,current=>turnAuthorized()?{links:{...current.links,[chatKey]:result.conversationId}}:null);
      if(!turnAuthorized())return;
      const reply=result.error?`That didn’t work: ${result.error}`:result.text||'(No text in the reply.)';
      if(task)await this.sendTask(identity,reply);else await bridge.send(chatKey,reply,{signal:controller.signal});
    }catch(error){if(authorized()&&!controller.signal.aborted)await bridge.send(chatKey,`That didn’t work: ${safeError(error,bridge.token||'unused-token')}`).catch(()=>{});}
    finally{clearInterval(typing);turns.delete(controller);if(!turns.size)this.turns.delete(userKey);}
  }
}
