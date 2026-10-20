import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROVIDER_CATALOG,getProvider} from './provider-catalog.mjs';
import {encryptProtectedSecret,decryptProtectedSecret} from './secret-storage.mjs';
import {connectionEndpoint,isLocalEndpoint} from './api-endpoint.mjs';
export {connectionEndpoint} from './api-endpoint.mjs';
function modelId(value) {
  const model = String(value || '').trim();
  if (!model || model.length > 200 || /[\x00-\x20]/.test(model) || ['auto','default'].includes(model.toLowerCase())) throw Error('Choose a model or enter its exact model ID.');
  return model;
}
const validKey = value => typeof value === 'string' && value.trim().length <= 4096 && !/[\r\n\x00]/.test(value);

export class ApiConnections {
  constructor({dataDir,encryption,fetchImpl=fetch}) { this.dataDir=dataDir;this.encryption=encryption;this.fetchImpl=fetchImpl;this.records={};this.queue=Promise.resolve(); }
  async init() {
    await mkdir(this.dataDir,{recursive:true});this.file=path.join(this.dataDir,'api-connections.json');
    try { const saved=JSON.parse(await readFile(this.file,'utf8'));if(saved.version!==1 || !saved.records || typeof saved.records!=='object')throw Error('Invalid connection store');this.records=saved.records; }
    catch(error) { if(error.code!=='ENOENT')throw Error('API connection settings could not be read. Preserve api-connections.json before repairing it.'); }
  }
  status() {
    return PROVIDER_CATALOG.filter(p=>p.mode!=='subscription').map(p=>{
      const saved=this.records[p.id];const hasKey=!!saved?.encryptedKey;
      const configured=!!(saved?.model && saved?.baseUrl && (p.mode==='local' || p.optionalKey || hasKey));
      const capabilities=p.configurableEndpoint?{supportsTools:saved?.supportsTools===true,supportsImages:saved?.supportsImages===true,maxOutputTokens:saved?.maxOutputTokens||2048,local:isLocalEndpoint(saved?.baseUrl)}:{};
      return {id:p.id,name:p.name,installed:true,connected:configured,configured,hasKey,...capabilities,status:configured?'configured':'not-configured',model:saved?.model||'',baseUrl:saved?.baseUrl||p.baseUrl||'',detail:configured?`Configured${p.configurableEndpoint?' · '+saved.model+' · '+(capabilities.local?'local server':new URL(saved.baseUrl).host):' locally'}. No live model request has been tested.`:p.configurableEndpoint?'Choose a local or hosted server. API key optional.':p.mode==='local'?'Connect your local model server.':'Add an API key and choose a model. No automatic fallback.'};
    });
  }
  async save() {
    const value=JSON.stringify({version:1,records:this.records},null,2);
    this.queue=this.queue.catch(()=>{}).then(async()=>{const temp=this.file+'.'+randomUUID()+'.tmp';await writeFile(temp,value,{mode:0o600});await rename(temp,this.file);});return this.queue;
  }
  async configure(input) {
    const provider=getProvider(input.provider);
    if(!provider || provider.mode==='subscription')throw Error('Choose an API or local connection.');
    const previous=this.records[provider.id]||{};
    const baseUrl=connectionEndpoint(provider,input.baseUrl||previous.baseUrl);
    if(provider.mode==='api' && !(provider.configurableEndpoint&&isLocalEndpoint(baseUrl)) && input.allowPaidApi!==true)throw Error('Confirm this API connection’s billing before saving.');
    const model=modelId(input.model);
    if(input.apiKey!==undefined && !validKey(input.apiKey))throw Error('Enter a valid API key.');
    const apiKey=input.apiKey?.trim();
    if(input.removeKey!==undefined && typeof input.removeKey!=='boolean')throw Error('Invalid key removal option.');
    if(input.removeKey && apiKey)throw Error('Choose either a new API key or removal of the saved key.');
    let encryptedKey=input.removeKey?undefined:previous.encryptedKey;
    if(apiKey) {
      encryptedKey=encryptProtectedSecret(this.encryption,apiKey).toString('base64');
    }
    if(provider.mode!=='local' && !provider.optionalKey && !encryptedKey)throw Error('Add this provider’s API key.');
    // Never carry an existing credential to a newly entered custom host.
    if(previous.baseUrl && previous.baseUrl!==baseUrl && encryptedKey && !apiKey)throw Error('Re-enter the API key when changing its destination.');
    const capabilities={};
    if(provider.configurableEndpoint){
      for(const key of ['supportsTools','supportsImages']){
        if(input[key]!==undefined&&typeof input[key]!=='boolean')throw Error('Model capabilities must be on or off.');
        capabilities[key]=input[key]??previous[key]??false;
      }
      const maximum=input.maxOutputTokens??previous.maxOutputTokens??2048;
      if(!Number.isInteger(maximum)||maximum<128||maximum>32768)throw Error('Set the maximum reply length between 128 and 32768 tokens.');
      capabilities.maxOutputTokens=maximum;
    }
    this.records[provider.id]={baseUrl,model,...capabilities,...(encryptedKey?{encryptedKey}:{}),savedAt:new Date().toISOString()};
    await this.save();return this.status().find(item=>item.id===provider.id);
  }
  async disconnect(id) { if(!getProvider(id)||getProvider(id).mode==='subscription')throw Error('Choose an API or local connection.');delete this.records[id];await this.save();return {}; }
  async getConnection(id) {
    const provider=getProvider(id), saved=this.records[id];
    if(!provider || provider.mode==='subscription' || !saved)throw Error('Configure this connection first.');
    let apiKey='';
    if(saved.encryptedKey)apiKey=decryptProtectedSecret(this.encryption,Buffer.from(saved.encryptedKey,'base64'));
    if(provider.mode!=='local' && !provider.optionalKey && !apiKey)throw Error('Add this provider’s API key.');
    return {provider:id,protocol:provider.protocol||'openai',baseUrl:connectionEndpoint(provider,saved.baseUrl),model:modelId(saved.model),apiKey,...(provider.configurableEndpoint?{optionalKey:true,supportsTools:saved.supportsTools===true,supportsImages:saved.supportsImages===true,maxOutputTokens:saved.maxOutputTokens||2048}:{})};
  }
  async models(input) {
    const provider=getProvider(input.provider);
    if(!provider || provider.mode==='subscription')throw Error('Model discovery is available for API and local connections.');
    const saved=this.records[provider.id];
    const baseUrl=connectionEndpoint(provider,input.baseUrl||saved?.baseUrl);
    if(input.apiKey!==undefined && !validKey(input.apiKey))throw Error('Enter a valid API key.');
    let key=input.apiKey?.trim()||'';
    if(!key && saved?.encryptedKey && input.removeKey!==true) {
      if(saved.baseUrl!==baseUrl)throw Error('Enter a key for the new destination.');
      key=decryptProtectedSecret(this.encryption,Buffer.from(saved.encryptedKey,'base64'));
    }
    if(provider.mode!=='local'&&!provider.optionalKey&&!key)throw Error('Enter an API key to load models.');
    const headers={Accept:'application/json'};
    if(provider.protocol==='anthropic'){headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}
    else if(key)headers.Authorization=`Bearer ${key}`;
    let response;
    const url=provider.modelsFromOrigin?new URL(provider.modelsPath,baseUrl).href:baseUrl+(provider.modelsPath||'/models');
    try{response=await this.fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw Error('Could not load models. Check the address and connection, or enter a model ID manually.');}
    if(!response.ok)throw Error(`Model discovery returned HTTP ${response.status}. Check your key and region, or enter a model ID manually. No completion was requested.`);
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw Error('The model list exceeded its size limit.');chunks.push(chunk);}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('The server did not return a JSON model list. Enter a model ID manually.');}
    const values=result.data||result.models||result.output?.models;
    if(!Array.isArray(values))throw Error('This server does not provide a compatible model list. Enter a model ID manually.');
    const models=[...new Map(values.filter(item=>item&&typeof item==='object').map(item=>{const id=String(item.id||item.model||item.name||'').replace(/^models\//,'');return [id,{id,label:String(item.display_name||item.displayName||item.name||id).slice(0,300)}];}).filter(([id])=>id&&id.length<=200&&!/[\x00-\x20]/.test(id)&&!['auto','default'].includes(id.toLowerCase()))).values()].slice(0,2000);
    return {models,message:'Model names loaded. Availability and tool support depend on your account and selected model; no completion was requested.'};
  }
}
