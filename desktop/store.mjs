import {mkdir} from 'node:fs/promises';
import {readRecoverableState,removeOrphanedTemps,durableReplace,backupState,backupFromFile,validateState,serializeState,digestChunks} from './durable-state.mjs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {orderedPins} from './chat-management.mjs';
/** Retire the removed connection while retaining original messages and their provider attribution. */
export function retireGeminiCli(state){
  let changed=0;
  const migrateSelection=value=>{if(value?.provider==='gemini-cli'){Object.assign(value,{provider:'antigravity',model:'auto',effort:'',speed:''});changed++;}};
  migrateSelection(state.settings);
  for(const c of state.conversations||[]){
    if(c.provider==='gemini-cli'){c.provider='antigravity';changed++;}
    migrateSelection(c.selection);
    for(const field of ['sessions','sessionSeen','contextSent','selections'])for(const key of Object.keys(c[field]||{}))if(key.split(':')[0]==='gemini-cli'){delete c[field][key];changed++;}
  }
  for(const task of state.schedules||[])migrateSelection(task);
  const prefs=state.settings?.modelPreferences;
  if(prefs?.models&&Object.hasOwn(prefs.models,'gemini-cli')){delete prefs.models['gemini-cli'];changed++;}
  if(Array.isArray(prefs?.hiddenProviders)&&prefs.hiddenProviders.includes('gemini-cli')){prefs.hiddenProviders=prefs.hiddenProviders.filter(id=>id!=='gemini-cli');changed++;}
  if(Array.isArray(prefs?.fallback?.targets)&&prefs.fallback.targets.some(item=>item?.provider==='gemini-cli')){prefs.fallback.targets=prefs.fallback.targets.filter(item=>item?.provider!=='gemini-cli');changed++;}
  return changed?['gemini-cli']:[];
}
// Connections that were taken out of Exomina, with the connection their chats and settings continue with.
export const REMOVED_PROVIDERS=Object.freeze({'kimi-code':'codex',copilot:'codex',deepseek:'codex',qwen:'codex',kimi:'codex',zai:'codex',minimax:'codex',mistral:'codex',openrouter:'codex',ollama:'codex',custom:'codex'});
const replacement=id=>typeof id==='string'&&Object.hasOwn(REMOVED_PROVIDERS,id)?REMOVED_PROVIDERS[id]:null;
/** Moves chats, defaults, schedules and picker preferences off removed connections. Message attribution stays as it was. */
export function retireRemovedProviders(state){
  const found=new Set();
  const migrate=value=>{const to=replacement(value?.provider);if(to){found.add(value.provider);Object.assign(value,{provider:to,model:'auto',effort:'',speed:''});}};
  migrate(state.settings);
  for(const c of state.conversations||[]){
    const to=replacement(c.provider);if(to){found.add(c.provider);c.provider=to;}
    migrate(c.selection);
    for(const field of ['sessions','sessionSeen','contextSent','selections'])for(const key of Object.keys(c[field]||{}))if(replacement(key.split(':')[0])){found.add(key.split(':')[0]);delete c[field][key];}
  }
  for(const task of state.schedules||[])migrate(task);
  const prefs=state.settings?.modelPreferences;
  if(prefs?.models)for(const id of Object.keys(prefs.models))if(replacement(id)){found.add(id);delete prefs.models[id];}
  if(Array.isArray(prefs?.hiddenProviders)&&prefs.hiddenProviders.some(replacement)){prefs.hiddenProviders.filter(replacement).forEach(id=>found.add(id));prefs.hiddenProviders=prefs.hiddenProviders.filter(id=>!replacement(id));}
  if(Array.isArray(prefs?.fallback?.targets)&&prefs.fallback.targets.some(item=>replacement(item?.provider))){prefs.fallback.targets.filter(item=>replacement(item?.provider)).forEach(item=>found.add(item.provider));prefs.fallback.targets=prefs.fallback.targets.filter(item=>!replacement(item?.provider));}
  return [...found];
}
export class Store{
  constructor(dir,{workspace=path.join(dir,'workspace'),writeState=durableReplace,writeBackup=(dir,previous)=>previous?.file?backupFromFile(dir,previous.file,previous.digest):backupState(dir,previous)}={}){this.dir=dir;this.writeState=writeState;this.writeBackup=writeBackup;this.saving=false;this.pendingSave=false;this.completedWrites=0;this.queue=Promise.resolve();this.state={settings:{provider:'codex',model:'',effort:'',closeToTray:true,memoryEnabled:true,memoryCapture:'automatic',chatMemoryEnabled:true,chatMemorySummaries:true,desktopEnabled:false,browserEnabled:false,cuaDriverPath:'',workspace,permissionMode:'ask',permissionRules:[],spellcheck:{enabled:true,languages:[]},autoTitle:true},conversations:[]}}
  async init(){
    await mkdir(this.dir,{recursive:true});this.removedTemps=await removeOrphanedTemps(this.dir);const loaded=await readRecoverableState(this.dir);
    if(loaded.state)this.state={...this.state,...loaded.state,settings:{...this.state.settings,...loaded.state.settings}};
    this.lastDurableHash=loaded.text===null?null:createHash('sha256').update(loaded.text).digest('hex');this.recovery=loaded.recovery;this.lastBackupAt=0;
    orderedPins(this.state.conversations);
    await mkdir(this.state.settings.workspace,{recursive:true});this.retiredProviders=[...retireGeminiCli(this.state),...retireRemovedProviders(this.state)];
  }
  save(){
    // Keep IDs and retired-provider selections normalized synchronously: some
    // callers inspect the in-memory state before awaiting the durable write.
    retireGeminiCli(this.state);retireRemovedProviders(this.state);for(const c of this.state.conversations)for(const m of c.messages)m.id??=randomUUID();
    validateState(this.state);this.pendingSave=true;
    if(this.saving)return this.queue;
    this.saving=true;
    this.queue=this.queue.catch(()=>{}).then(async()=>{
      try{
        while(this.pendingSave){
          this.pendingSave=false;
          validateState(this.state);
          // Serialize only when the writer is ready. A tool-event burst keeps
          // one active snapshot and a dirty flag, not one whole store per event.
          // Private chats live in memory only and are never written to disk.
          // Serializing, hashing and writing yield between slices: a 70 MB
          // library in one pass froze keyboard input for most of a second.
          const data=await serializeState(this.state,{omit:c=>c?.private===true});
          const digest=await digestChunks(data);
          if(digest===this.lastDurableHash)continue;
          if(!this.lastBackupAt||Date.now()-this.lastBackupAt>=30000){
            // The previous durable generation already lives on disk. Copy it
            // and verify the copy instead of reading and parsing the library.
            await this.writeBackup(this.dir,this.lastDurableHash===null?data:{file:path.join(this.dir,'state.json'),digest:this.lastDurableHash});this.lastBackupAt=Date.now();
          }
          await this.writeState(path.join(this.dir,'state.json'),data);this.lastDurableHash=digest;this.completedWrites++;
        }
      }finally{this.saving=false;}
    });return this.queue;
  }
  conversation(id){const c=this.state.conversations.find(c=>c.id===id);if(!c)throw Error('Chat not found');return c}
  create(provider,{isPrivate=false}={}){const c={id:randomUUID(),title:isPrivate?'Temporary chat':'New chat',titleSource:isPrivate?'manual':'pending',pinned:false,archived:false,provider,updatedAt:new Date().toISOString(),messages:[],sessions:{},...(isPrivate?{private:true}:{})};this.state.conversations.unshift(c);return c}
}
