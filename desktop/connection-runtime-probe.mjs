import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function hasRuntimeOption(help,flag){
  if(flag.startsWith('--'))return new Set(help.match(/--[a-z][a-z0-9-]*/g)||[]).has(flag);
  return new RegExp(`(?:^|\\s)${flag}(?=[\\s,=]|$)`,'m').test(help);
}
// A capability probe has a fresh, empty config and no inherited credentials.
// It sends no model prompt and connects no MCP server. This checks the protocol,
// not account access or every native tool's behaviour.
export async function probeConnectionRuntime(id,command,version,directory){
  const home=path.join(directory,'probe-'+randomUUID());await mkdir(home,{recursive:true});
  for(const part of ['codex','claude','tmp','config','cache','appdata','local'])await mkdir(path.join(home,part));
  const env={HOME:home,USERPROFILE:home,APPDATA:path.join(home,'appdata'),LOCALAPPDATA:path.join(home,'local'),TMP:path.join(home,'tmp'),TEMP:path.join(home,'tmp'),TMPDIR:path.join(home,'tmp'),XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),CODEX_HOME:path.join(home,'codex'),CLAUDE_CONFIG_DIR:path.join(home,'claude'),DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',LANG:'en_US.UTF-8',PATH:process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32'):'/usr/bin:/bin'};
  if(process.platform==='win32'){env.SystemRoot=process.env.SystemRoot||'C:\\Windows';env.WINDIR=env.SystemRoot;}
  await writeFile(path.join(home,'codex','config.toml'),'cli_auth_credentials_store = "file"\n','utf8');
  const common={cwd:home,env,shell:false,windowsHide:true,detached:process.platform!=='win32'};
  const versionText=await capture(command,['--version'],common);
  if(!(id==='codex'?new RegExp(`^codex-cli ${version.replaceAll('.','\\.')}\\s*$`):new RegExp(`^${version.replaceAll('.','\\.')} \\(Claude Code\\)\\s*$`)).test(versionText.trim()))throw Error('The downloaded connection reported a different version.');
  const help=await capture(command,['--help'],common);
  const required=id==='codex'?['app-server','cloud']:['--input-format','--output-format','--replay-user-messages','--include-partial-messages','--permission-mode','--permission-prompt-tool','--strict-mcp-config','--mcp-config','--setting-sources','--no-session-persistence'];
  const missing=required.filter(flag=>!hasRuntimeOption(help,flag));
  if(missing.length)throw Error('The new connection is missing options required by Exomina: '+missing.join(', ')+'.');
  if(id==='codex'){
    const schema=path.join(home,'schema');await mkdir(schema);
    await capture(command,['app-server','generate-json-schema','--experimental','--out',schema],common,60000);
    let text='';async function read(directory){for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isDirectory())await read(path.join(directory,entry.name));else if(entry.name.endsWith('.json')){const content=await readFile(path.join(directory,entry.name),'utf8');if(content.length>20*1024*1024)throw Error('Connection schema is too large.');text+=content;}}}await read(schema);
    for(const method of ['thread/start','thread/resume','turn/start','turn/interrupt','model/list','item/tool/call','item/commandExecution/requestApproval','item/fileChange/requestApproval'])if(!text.includes(`"${method}"`))throw Error(`The new connection no longer supports ${method}.`);
    await handshake(command,['app-server','--listen','stdio://'],common,id,version);
  }else await handshake(command,['-p','--input-format','stream-json','--output-format','stream-json','--replay-user-messages','--include-partial-messages','--verbose','--permission-mode','plan','--permission-prompt-tool','stdio','--setting-sources','user','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--no-session-persistence'],common,id,version);
  return {version,checks:['version','required options',id==='codex'?'protocol schema and initialize':'SDK initialize'],noPrompt:true};
}
function kill(child){
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('close',()=>{clearTimeout(timer);resolve();});
    if(process.platform==='win32'){const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});killer.on('error',()=>child.kill());}
    else try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}
  });
}
function capture(command,args,options,timeout=30000){return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});let text='',bytes=0,done=false;
  const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);if(error){kill(child).finally(()=>reject(error));}else resolve(text);};
  const timer=setTimeout(()=>finish(Error('Connection compatibility check timed out. The current version was kept.')),timeout);
  const read=data=>{bytes+=data.length;if(bytes>2*1024*1024)finish(Error('Connection compatibility output is too large.'));else text+=data.toString('utf8');};child.stdout.on('data',read);child.stderr.on('data',read);child.on('error',finish);child.on('close',code=>finish(code===0?null:Error('Connection compatibility command failed.')));
});}
function handshake(command,args,options,id,version){return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{...options,stdio:['pipe','pipe','pipe']}),requestId=randomUUID();let buffer='',done=false,bytes=0;
  const finish=error=>{if(done)return;done=true;clearTimeout(timer);kill(child).finally(()=>{error?reject(error):resolve();});};
  const timer=setTimeout(()=>finish(Error('The new connection did not complete its protocol handshake.')),30000);
  child.on('error',finish);child.on('close',()=>finish(Error('The new connection closed before its protocol handshake.')));child.stderr.resume();child.stdin.on('error',error=>{if(!done)finish(error);});
  child.stdout.on('data',chunk=>{
    if(done)return;bytes+=chunk.length;if(bytes>2*1024*1024){finish(Error('Connection handshake output is too large.'));return;}buffer+=chunk.toString('utf8');let index;
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;let message;try{message=JSON.parse(line);}catch{finish(Error('The new connection returned invalid protocol JSON.'));return;}
      if(id==='codex'&&message.id===1&&!message.method){if(message.error||typeof message.result?.userAgent!=='string'||!message.result.userAgent.includes('/'+version+' ')){finish(Error('The new connection has an incompatible initialize response.'));return;}child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');finish();return;}
      if(id==='claude'&&message.type==='control_response'&&message.response?.request_id===requestId){if(message.response.subtype!=='success'||!Array.isArray(message.response.response?.models)){finish(Error('The new connection has an incompatible SDK initialize response.'));return;}finish();return;}
      if(id==='codex'&&message.method&&message.id!==undefined)child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Actions disabled during compatibility checks.'}})+'\n');
      if(id==='claude'&&message.type==='control_request')child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Actions disabled during compatibility checks.'}})+'\n');
    }
  });
  child.stdin.write(JSON.stringify(id==='codex'?{id:1,method:'initialize',params:{clientInfo:{name:'exomina_update_check',version:'1.0.0'},capabilities:{experimentalApi:true}}}:{type:'control_request',request_id:requestId,request:{subtype:'initialize',hooks:null}})+'\n');
});}
