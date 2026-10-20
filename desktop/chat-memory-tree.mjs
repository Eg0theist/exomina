import {mkdir, lstat, chmod} from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import { SEARCH_ONLY_CHARS, searchOnlyNote, searchOnlyRangeNote, isMachineKind, machineExcerpt, machineRangeNote, toolName, characters } from './chat-memory-classification.mjs';

const bytes=value=>Buffer.byteLength(value,'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>JSON.stringify(value,(_,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const integer=(value,name,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`Invalid ${name}.`);return value;};
const identifier=(value,name,max=512)=>{if(typeof value!=='string'||!value.length||bytes(value)>max||value.includes('\0'))throw Error(`Invalid ${name}.`);return value;};
const validText=value=>{if(typeof value!=='string'||Buffer.from(value,'utf8').toString('utf8')!==value)throw Error('Text must contain valid Unicode.');return value;};
const validRange=(id,count)=>{integer(id,'node id');integer(count,'node count',1);const width=BigInt(count);if((width&(width-1n))!==0n||id%count!==0||!Number.isSafeInteger(id+count))throw Error('Nodes must be aligned power-of-two ranges.');};
const prefix=event=>`[${event.role}/${event.kind}]`;
const pendingText='[Summary pending; original remains available through conversation_zoom.]';
const entryBytes=(id,count,text)=>bytes(`${id}+${count} ${text}\n`);
const DETERMINISTIC='deterministic-tool-entries-v1:';

/** Original events are append-only; binary summaries and independent views are persistent caches. */
export class ChatMemoryTree {
  #db=null;
  #initializing=null;
  #statements=new Map();
  constructor(dataDir,options={}){
    this.dir=path.join(path.resolve(dataDir),'chat-memory');
    this.options={turnHigh:128000,turnLow:64000,compactionHigh:32000,compactionLow:16000,maxSummaryBytes:512,...options};
    for(const name of ['turnHigh','turnLow','compactionHigh','compactionLow','maxSummaryBytes'])integer(this.options[name],name,1);
    if(this.options.turnLow>=this.options.turnHigh||this.options.compactionLow>=this.options.compactionHigh||this.options.maxSummaryBytes>512)throw Error('Invalid chat memory byte budgets.');
  }
  async init(){
    if(this.#db)return this;
    if(this.#initializing)return this.#initializing;
    this.#initializing=(async()=>{
      await mkdir(this.dir,{recursive:true,mode:0o700});
      if((await lstat(this.dir)).isSymbolicLink())throw Error('Chat memory cannot use a linked directory.');
      const filename=path.join(this.dir,'tree.sqlite');
      try{if(!(await lstat(filename)).isFile()||(await lstat(filename)).isSymbolicLink())throw Error('Chat memory database must be a regular file.');}catch(error){if(error.code!=='ENOENT')throw error;}
      const db=new DatabaseSync(filename);
      try{
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS tree_chats(chat_id TEXT PRIMARY KEY,next_id INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,original_bytes INTEGER NOT NULL DEFAULT 0,node_count INTEGER NOT NULL DEFAULT 0,built_count INTEGER NOT NULL DEFAULT 0,ready_count INTEGER NOT NULL DEFAULT 0,running_count INTEGER NOT NULL DEFAULT 0,failed_count INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS tree_originals(chat_id TEXT NOT NULL REFERENCES tree_chats(chat_id) ON DELETE CASCADE,id INTEGER NOT NULL,event_key TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,text TEXT NOT NULL,metadata TEXT NOT NULL,source_hash TEXT NOT NULL,PRIMARY KEY(chat_id,id),UNIQUE(chat_id,event_key));
          CREATE TRIGGER IF NOT EXISTS tree_original_immutable BEFORE UPDATE ON tree_originals BEGIN SELECT RAISE(ABORT,'Chat originals are immutable.'); END;
          CREATE TABLE IF NOT EXISTS tree_nodes(chat_id TEXT NOT NULL REFERENCES tree_chats(chat_id) ON DELETE CASCADE,id INTEGER NOT NULL,count INTEGER NOT NULL,text TEXT,source_hash TEXT NOT NULL,content_hash TEXT,built_as TEXT,PRIMARY KEY(chat_id,id,count));
          CREATE INDEX IF NOT EXISTS tree_saved_model ON tree_nodes(chat_id,id,count) WHERE built_as='summary';
          CREATE TABLE IF NOT EXISTS tree_summary_commits(chat_id TEXT NOT NULL,id INTEGER NOT NULL,count INTEGER NOT NULL,origin TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,saved_at TEXT NOT NULL,PRIMARY KEY(chat_id,id,count),FOREIGN KEY(chat_id,id,count) REFERENCES tree_nodes(chat_id,id,count) ON DELETE CASCADE);
          CREATE INDEX IF NOT EXISTS tree_summary_saved_at ON tree_summary_commits(saved_at DESC);
          CREATE INDEX IF NOT EXISTS tree_leaf_pending ON tree_nodes(chat_id,id) WHERE count=1 AND text IS NULL;
          CREATE TABLE IF NOT EXISTS tree_jobs(chat_id TEXT NOT NULL REFERENCES tree_chats(chat_id) ON DELETE CASCADE,id INTEGER NOT NULL,count INTEGER NOT NULL,source_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'ready',token TEXT,attempts INTEGER NOT NULL DEFAULT 0,blocked_generation INTEGER NOT NULL DEFAULT -1,last_error TEXT,PRIMARY KEY(chat_id,id,count));
          CREATE INDEX IF NOT EXISTS tree_job_ready ON tree_jobs(state,count,id,chat_id);
          CREATE INDEX IF NOT EXISTS tree_job_chat_ready ON tree_jobs(chat_id,state,count,id);
          CREATE TABLE IF NOT EXISTS tree_views(chat_id TEXT NOT NULL REFERENCES tree_chats(chat_id) ON DELETE CASCADE,mode TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,compacting INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,mode));
          CREATE TABLE IF NOT EXISTS tree_view_entries(chat_id TEXT NOT NULL,mode TEXT NOT NULL,id INTEGER NOT NULL,count INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(chat_id,mode,id),FOREIGN KEY(chat_id,mode) REFERENCES tree_views(chat_id,mode) ON DELETE CASCADE);
          CREATE TABLE IF NOT EXISTS tree_view_candidates(chat_id TEXT NOT NULL,mode TEXT NOT NULL,id INTEGER NOT NULL,count INTEGER NOT NULL,last_id INTEGER NOT NULL,saved_bytes INTEGER NOT NULL,PRIMARY KEY(chat_id,mode,id,count),FOREIGN KEY(chat_id,mode) REFERENCES tree_views(chat_id,mode) ON DELETE CASCADE);
          CREATE INDEX IF NOT EXISTS tree_candidate_view ON tree_view_candidates(chat_id,mode,id,count);
          UPDATE tree_jobs SET state='ready',token=NULL WHERE state='running';`);
        const columns=new Set(db.prepare('PRAGMA table_info(tree_chats)').all().map(column=>column.name));let addedJobCounts=false;
        for(const column of ['ready_count','running_count','failed_count'])if(!columns.has(column)){db.exec(`ALTER TABLE tree_chats ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);addedJobCounts=true;}
        db.exec(`CREATE TABLE IF NOT EXISTS tree_migrations(name TEXT PRIMARY KEY);
          CREATE TRIGGER IF NOT EXISTS tree_job_count_insert AFTER INSERT ON tree_jobs BEGIN UPDATE tree_chats SET ready_count=ready_count+(NEW.state='ready'),running_count=running_count+(NEW.state='running'),failed_count=failed_count+(NEW.state='failed') WHERE chat_id=NEW.chat_id; END;
          CREATE TRIGGER IF NOT EXISTS tree_job_count_delete AFTER DELETE ON tree_jobs BEGIN UPDATE tree_chats SET ready_count=ready_count-(OLD.state='ready'),running_count=running_count-(OLD.state='running'),failed_count=failed_count-(OLD.state='failed') WHERE chat_id=OLD.chat_id; END;
          CREATE TRIGGER IF NOT EXISTS tree_job_count_state AFTER UPDATE OF state ON tree_jobs WHEN OLD.state<>NEW.state BEGIN UPDATE tree_chats SET ready_count=ready_count-(OLD.state='ready')+(NEW.state='ready'),running_count=running_count-(OLD.state='running')+(NEW.state='running'),failed_count=failed_count-(OLD.state='failed')+(NEW.state='failed') WHERE chat_id=NEW.chat_id; END;`);
        if(addedJobCounts||!db.prepare('SELECT 1 FROM tree_migrations WHERE name=?').get('job-counts-v1')){
          db.exec(`BEGIN IMMEDIATE; UPDATE tree_chats SET
            ready_count=(SELECT COUNT(*) FROM tree_jobs WHERE tree_jobs.chat_id=tree_chats.chat_id AND state='ready'),
            running_count=(SELECT COUNT(*) FROM tree_jobs WHERE tree_jobs.chat_id=tree_chats.chat_id AND state='running'),
            failed_count=(SELECT COUNT(*) FROM tree_jobs WHERE tree_jobs.chat_id=tree_chats.chat_id AND state='failed');
            INSERT OR IGNORE INTO tree_migrations VALUES('job-counts-v1'); COMMIT;`);
        }
        this.#db=db;
        if(process.platform!=='win32')await chmod(filename,0o600);
        return this;
      }catch(error){db.close();this.#db=null;throw error;}
    })();
    try{return await this.#initializing;}finally{this.#initializing=null;}
  }
  #sql(sql){let statement=this.#statements.get(sql);if(!statement){statement=this.#db.prepare(sql);this.#statements.set(sql,statement);}return statement;}
  #transaction(run){this.#db.exec('BEGIN IMMEDIATE');try{const result=run();this.#db.exec('COMMIT');return result;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  #chat(chatId){return this.#sql('SELECT * FROM tree_chats WHERE chat_id=?').get(chatId);}
  #normalize(event){
    if(!plain(event))throw Error('A chat event is required.');
    const key=identifier(event.key??event.eventKey,'event key',1024),text=validText(event.text??'');
    const role=event.role??'unknown',kind=event.kind??'message';
    for(const value of [role,kind])if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,48}$/.test(value))throw Error('Invalid chat role or event kind.');
    const metadata=canonical(event.metadata??{});
    if(metadata===undefined||bytes(metadata)>1048576)throw Error('Chat metadata exceeds its limit.');
    const suppliedDate=event.createdAt??event.date??null;
    if(suppliedDate!==null&&(typeof suppliedDate!=='string'||!Number.isFinite(Date.parse(suppliedDate))))throw Error('Invalid chat event date.');
    const createdAt=suppliedDate===null?'':new Date(suppliedDate).toISOString();
    const sourceHash=hash(canonical({key,text,role,kind,metadata:JSON.parse(metadata),createdAt:suppliedDate===null?null:createdAt}));
    return {key,text,role,kind,metadata,createdAt,sourceHash};
  }
  #ensureChat(chatId){
    this.#sql('INSERT OR IGNORE INTO tree_chats(chat_id) VALUES(?)').run(chatId);
    for(const mode of ['turn','compaction'])this.#sql('INSERT OR IGNORE INTO tree_views(chat_id,mode) VALUES(?,?)').run(chatId,mode);
  }
  #ensureNode(chatId,id,count,sourceHash){
    const inserted=this.#sql('INSERT OR IGNORE INTO tree_nodes(chat_id,id,count,source_hash) VALUES(?,?,?,?)').run(chatId,id,count,sourceHash).changes;
    if(inserted)this.#sql('UPDATE tree_chats SET node_count=node_count+1 WHERE chat_id=?').run(chatId);
  }
  #candidate(chatId,mode,id,count){
    const width=count*2,left=Math.floor(id/width)*width;
    this.#sql('DELETE FROM tree_view_candidates WHERE chat_id=? AND mode=? AND id=? AND count=?').run(chatId,mode,left,width);
    const first=this.#sql('SELECT count,bytes FROM tree_view_entries WHERE chat_id=? AND mode=? AND id=?').get(chatId,mode,left);
    if(first?.count!==count)return;
    const second=this.#sql('SELECT count,bytes FROM tree_view_entries WHERE chat_id=? AND mode=? AND id=?').get(chatId,mode,left+count);
    if(second?.count!==count)return;
    const parent=this.#sql('SELECT text FROM tree_nodes WHERE chat_id=? AND id=? AND count=?').get(chatId,left,width);
    if(parent?.text==null)return;
    const saved=first.bytes+second.bytes-entryBytes(left,width,parent.text);
    if(saved>0)this.#sql('INSERT INTO tree_view_candidates(chat_id,mode,id,count,last_id,saved_bytes) VALUES(?,?,?,?,?,?)').run(chatId,mode,left,width,left+width-1,saved);
  }
  #buildNode(chatId,id,count,text,sourceHash,builtAs){
    this.#ensureNode(chatId,id,count,sourceHash);
    const contentHash=hash(canonical({sourceHash,text}));
    const changed=this.#sql('UPDATE tree_nodes SET text=?,content_hash=?,built_as=? WHERE chat_id=? AND id=? AND count=? AND text IS NULL AND source_hash=?').run(text,contentHash,builtAs,chatId,id,count,sourceHash).changes;
    if(!changed)return false;
    this.#sql('UPDATE tree_chats SET built_count=built_count+1,revision=revision+1 WHERE chat_id=?').run(chatId);
    this.#sql('DELETE FROM tree_jobs WHERE chat_id=? AND id=? AND count=?').run(chatId,id,count);
    for(const mode of ['turn','compaction']){
      const entry=this.#sql('SELECT count,bytes FROM tree_view_entries WHERE chat_id=? AND mode=? AND id=?').get(chatId,mode,id);
      if(entry?.count===count){
        const size=entryBytes(id,count,text);
        this.#sql('UPDATE tree_view_entries SET bytes=? WHERE chat_id=? AND mode=? AND id=?').run(size,chatId,mode,id);
        this.#sql('UPDATE tree_views SET bytes=bytes+?,revision=revision+1 WHERE chat_id=? AND mode=?').run(size-entry.bytes,chatId,mode);
        this.#candidate(chatId,mode,id,count);
      }
      if(count>1)this.#candidate(chatId,mode,id,count/2);
    }
    this.#refreshParent(chatId,id,count);
    return true;
  }
  #refreshParent(chatId,id,count){
    const width=count*2,left=Math.floor(id/width)*width;
    if(!Number.isSafeInteger(left+width)||left+width>this.#chat(chatId).next_id)return;
    const children=this.#sql('SELECT id,text,content_hash,built_as FROM tree_nodes WHERE chat_id=? AND count=? AND id IN (?,?) ORDER BY id').all(chatId,count,left,left+count);
    if(children.length!==2||children.some(child=>child.text==null))return;
    const sourceHash=hash(canonical(children.map(child=>({id:child.id,count,hash:child.content_hash}))));
    this.#ensureNode(chatId,left,width,sourceHash);
    if(this.#sql('SELECT text FROM tree_nodes WHERE chat_id=? AND id=? AND count=?').get(chatId,left,width).text!==null)return;
    const joined=children.map(child=>child.text).join('\n');
    if(children.every(child=>child.built_as==='search-only') && bytes(searchOnlyRangeNote)<=this.options.maxSummaryBytes)this.#buildNode(chatId,left,width,searchOnlyRangeNote,sourceHash,'search-only');
    else if(bytes(joined)<=this.options.maxSummaryBytes)this.#buildNode(chatId,left,width,joined,sourceHash,'joined');
    else{const note=this.#machineRangeNote(chatId,left,width);if(note)this.#buildNode(chatId,left,width,note,sourceHash,'machine');else this.#sql('INSERT OR IGNORE INTO tree_jobs(chat_id,id,count,source_hash) VALUES(?,?,?,?)').run(chatId,left,width,sourceHash);}
  }
  // Null unless every original in the range is a tool call or tool output.
  #machineRangeNote(chatId,id,count){
    if(this.#sql("SELECT 1 FROM tree_originals WHERE chat_id=? AND id>=? AND id<? AND kind NOT IN ('tool','echo') LIMIT 1").get(chatId,id,id+count))return null;
    const counts=new Map();
    for(const row of this.#sql("SELECT substr(text,1,200) AS head FROM tree_originals WHERE chat_id=? AND id>=? AND id<? AND kind='tool'").all(chatId,id,id+count)){const name=toolName(row.head);counts.set(name,(counts.get(name)||0)+1);}
    const echo=this.#sql("SELECT COUNT(*) AS outputs,SUM(json_extract(metadata,'$.status')='error' OR substr(text,1,11)='Tool error:') AS errors FROM tree_originals WHERE chat_id=? AND id>=? AND id<? AND kind='echo'").get(chatId,id,id+count);
    const names=[...counts].map(([name,n])=>({name,count:n})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name));
    const calls=names.reduce((sum,item)=>sum+item.count,0);
    const first=this.#sql(`SELECT substr(text,1,1200) AS head FROM tree_originals WHERE chat_id=? AND id>=? AND id<? AND kind=? ORDER BY id LIMIT 1`).get(chatId,id,id+count,calls?'tool':'echo')?.head??'';
    const last=calls?this.#sql("SELECT substr(text,-1200) AS end FROM tree_originals WHERE chat_id=? AND id>=? AND id<? AND kind='echo' ORDER BY id DESC LIMIT 1").get(chatId,id,id+count)?.end??'':'';
    return machineRangeNote({calls,outputs:echo.outputs,errors:echo.errors||0,names,first,last},this.options.maxSummaryBytes);
  }
  #leafNote(row,head){
    const label=prefix(row);
    if(row.kind==='echo'&&row.length>SEARCH_ONLY_CHARS){const note=`${label} ${searchOnlyNote(row.length)}`;return bytes(note)<=this.options.maxSummaryBytes?{note,as:'search-only'}:null;}
    const note=isMachineKind(row.kind)?machineExcerpt(label,head,this.options.maxSummaryBytes,row.length):null;
    return note&&bytes(note)<=this.options.maxSummaryBytes?{note,as:'excerpt'}:null;
  }
  #settleView(chatId,mode){
    const high=this.options[mode==='turn'?'turnHigh':'compactionHigh'],low=this.options[mode==='turn'?'turnLow':'compactionLow'];
    let state=this.#sql('SELECT * FROM tree_views WHERE chat_id=? AND mode=?').get(chatId,mode);
    if(state.bytes>high&&!state.compacting){this.#sql('UPDATE tree_views SET compacting=1 WHERE chat_id=? AND mode=?').run(chatId,mode);state.compacting=1;}
    while(state.compacting&&state.bytes>low){
      const time=this.#chat(chatId).next_id-1;
      const candidate=this.#sql('SELECT id,count,saved_bytes FROM tree_view_candidates WHERE chat_id=? AND mode=? ORDER BY CAST(?-last_id AS REAL)/count DESC,last_id ASC,id ASC LIMIT 1').get(chatId,mode,time);
      if(!candidate)break;
      const parent=this.#sql('SELECT text FROM tree_nodes WHERE chat_id=? AND id=? AND count=?').get(chatId,candidate.id,candidate.count);
      const half=candidate.count/2;
      this.#sql('DELETE FROM tree_view_candidates WHERE chat_id=? AND mode=? AND id=? AND count=?').run(chatId,mode,candidate.id,candidate.count);
      this.#sql('DELETE FROM tree_view_entries WHERE chat_id=? AND mode=? AND id IN (?,?)').run(chatId,mode,candidate.id,candidate.id+half);
      const size=entryBytes(candidate.id,candidate.count,parent.text);
      this.#sql('INSERT INTO tree_view_entries(chat_id,mode,id,count,bytes) VALUES(?,?,?,?,?)').run(chatId,mode,candidate.id,candidate.count,size);
      this.#sql('UPDATE tree_views SET bytes=bytes-?,revision=revision+1 WHERE chat_id=? AND mode=?').run(candidate.saved_bytes,chatId,mode);
      state.bytes-=candidate.saved_bytes;
      this.#candidate(chatId,mode,candidate.id,candidate.count);
    }
    if(state.compacting&&state.bytes<=low)this.#sql('UPDATE tree_views SET compacting=0 WHERE chat_id=? AND mode=?').run(chatId,mode);
  }
  #settle(chatId){for(const mode of ['turn','compaction'])this.#settleView(chatId,mode);}
  #append(chatId,event){
    const existing=this.#sql('SELECT id,source_hash FROM tree_originals WHERE chat_id=? AND event_key=?').get(chatId,event.key);
    if(existing){if(existing.source_hash!==event.sourceHash)throw Object.assign(Error('An event key already exists with different immutable content.'),{code:'CHAT_MEMORY_EVENT_CONFLICT'});return {chatId,id:existing.id,appended:false};}
    this.#ensureChat(chatId);
    const id=this.#chat(chatId).next_id;
    integer(id+1,'next node id');
    this.#sql('INSERT INTO tree_originals(chat_id,id,event_key,role,kind,created_at,text,metadata,source_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(chatId,id,event.key,event.role,event.kind,event.createdAt,event.text,event.metadata,event.sourceHash);
    this.#sql('UPDATE tree_chats SET next_id=next_id+1,generation=generation+1,revision=revision+1,original_bytes=original_bytes+? WHERE chat_id=?').run(bytes(event.text),chatId);
    this.#sql("UPDATE tree_jobs SET state='ready' WHERE chat_id=? AND state='failed' AND blocked_generation<?").run(chatId,this.#chat(chatId).generation);
    this.#ensureNode(chatId,id,1,event.sourceHash);
    for(const mode of ['turn','compaction']){
      const size=entryBytes(id,1,pendingText);
      this.#sql('INSERT INTO tree_view_entries(chat_id,mode,id,count,bytes) VALUES(?,?,?,1,?)').run(chatId,mode,id,size);
      this.#sql('UPDATE tree_views SET bytes=bytes+?,revision=revision+1 WHERE chat_id=? AND mode=?').run(size,chatId,mode);
    }
    const exact=`${prefix(event)} ${event.text}`;
    const leaf=isMachineKind(event.kind)?this.#leafNote({role:event.role,kind:event.kind,length:characters(event.text)},event.text.slice(0,4000)):null;
    if(leaf?.as==='search-only')this.#buildNode(chatId,id,1,leaf.note,event.sourceHash,'search-only');
    else if(bytes(exact)<=this.options.maxSummaryBytes)this.#buildNode(chatId,id,1,exact,event.sourceHash,'exact');
    else if(leaf)this.#buildNode(chatId,id,1,leaf.note,event.sourceHash,leaf.as);
    else this.#sql('INSERT INTO tree_jobs(chat_id,id,count,source_hash) VALUES(?,?,1,?)').run(chatId,id,event.sourceHash);
    return {chatId,id,appended:true};
  }
  async append(chatId,event){identifier(chatId,'chat id');const normalized=this.#normalize(event);await this.init();return this.#transaction(()=>{const result=this.#append(chatId,normalized);this.#settle(chatId);return result;});}
  /**
   * Catch up queued tool-only entries in small transactions while this chat is used.
   * Jobs are visited once in (count,id) order; parents completed meanwhile join later pages.
   * Pass the returned cursor back to continue. Originals are never edited.
   */
  async classifyDeterministic(chatId,{limit=64,cursor=null}={}){
    identifier(chatId,'chat id');integer(limit,'classification batch',1,1024);await this.init();
    const [afterCount,afterId]=cursor??[0,-1];integer(afterCount,'cursor count');integer(afterId+1,'cursor id');
    return this.#transaction(()=>{
      const jobs=this.#sql("SELECT id,count,source_hash FROM tree_jobs WHERE chat_id=? AND state IN ('ready','failed') AND (count>? OR count=? AND id>?) ORDER BY count,id LIMIT ?").all(chatId,afterCount,afterCount,afterId,limit);
      let classified=0;
      for(const job of jobs){
        let note=null,as='machine';
        if(job.count===1){const row=this.#sql('SELECT role,kind,length(text) AS length,substr(text,1,4000) AS head FROM tree_originals WHERE chat_id=? AND id=?').get(chatId,job.id);const leaf=row&&this.#leafNote(row,row.head);if(leaf)({note,as}=leaf);}
        else note=this.#machineRangeNote(chatId,job.id,job.count);
        if(note&&this.#buildNode(chatId,job.id,job.count,note,job.source_hash,as))classified++;
      }
      if(classified)this.#settle(chatId);
      const last=jobs.at(-1),done=jobs.length<limit;
      // Jobs created from here on are classified as they are queued, so one complete pass suffices.
      if(done)this.#sql('INSERT OR IGNORE INTO tree_migrations(name) VALUES(?)').run(DETERMINISTIC+chatId);
      return {classified,cursor:done?null:[last.count,last.id]};
    });
  }
  /** Whether queued jobs from before deterministic tool entries still need one catch-up pass. */
  async deterministicPending(chatId){identifier(chatId,'chat id');await this.init();return !this.#sql('SELECT 1 FROM tree_migrations WHERE name=?').get(DETERMINISTIC+chatId);}
  /** One page from the start; kept for callers of the earlier search-only catch-up. */
  async classifySearchOnly(chatId,{limit=64}={}){return this.classifyDeterministic(chatId,{limit});}
  async sync(chatId,events){
    identifier(chatId,'chat id');if(!Array.isArray(events))throw Error('Chat events must be an array.');const normalized=events.map(event=>this.#normalize(event));await this.init();
    return this.#transaction(()=>{const results=normalized.map(event=>this.#append(chatId,event));if(this.#chat(chatId))this.#settle(chatId);return {chatId,appended:results.filter(result=>result.appended).length,total:this.#chat(chatId)?.next_id??0,results};});
  }
  async resume(chatId){identifier(chatId,'chat id');await this.init();return this.#transaction(()=>{const changed=this.#sql('UPDATE tree_chats SET generation=generation+1 WHERE chat_id=?').run(chatId).changes;const generation=this.#chat(chatId)?.generation??0;this.#sql("UPDATE tree_jobs SET state='ready' WHERE chat_id=? AND state='failed' AND blocked_generation<?").run(chatId,generation);return {chatId,resumed:!!changed,generation};});}
  async readyJobs(limit=8,{chatId}={}){
    integer(limit,'job limit',1,1024);if(chatId!==undefined)identifier(chatId,'chat id');await this.init();
    return this.#transaction(()=>{
      // Eight unfinished earlier leaves form the boundary of the next leaf's
      // chronological context. The partial index probe visits at most eight.
      const rows=this.#sql(`SELECT j.chat_id,j.id,j.count,j.source_hash,j.attempts,c.generation FROM tree_jobs j JOIN tree_chats c ON c.chat_id=j.chat_id WHERE j.state='ready'${chatId===undefined?'':' AND j.chat_id=?'} AND (j.count>1 OR NOT EXISTS(SELECT 1 FROM tree_nodes earlier INDEXED BY tree_leaf_pending WHERE earlier.chat_id=j.chat_id AND earlier.count=1 AND earlier.text IS NULL AND earlier.id<j.id ORDER BY earlier.id LIMIT 1 OFFSET 7)) ORDER BY j.count,j.id,j.chat_id LIMIT ?`).all(...(chatId===undefined?[]:[chatId]),limit);
      return rows.map(row=>{const token=randomUUID();this.#sql("UPDATE tree_jobs SET state='running',token=?,attempts=attempts+1,last_error=NULL WHERE chat_id=? AND id=? AND count=?").run(token,row.chat_id,row.id,row.count);return {chatId:row.chat_id,id:row.id,count:row.count,sourceHash:row.source_hash,attempt:row.attempts+1,eventGeneration:row.generation,token};});
    });
  }
  #currentJob(job){
    if(!plain(job)||typeof job.chatId!=='string'||typeof job.token!=='string')return null;
    validRange(job.id,job.count);
    const row=this.#sql('SELECT * FROM tree_jobs WHERE chat_id=? AND id=? AND count=? AND state=\'running\' AND token=? AND source_hash=?').get(job.chatId,job.id,job.count,job.token,job.sourceHash);
    return row??null;
  }
  #entry(chatId,id,count){
    const node=this.#sql('SELECT text,source_hash,built_as FROM tree_nodes WHERE chat_id=? AND id=? AND count=?').get(chatId,id,count);
    const text=node?.text??pendingText;
    return {id,count,text,pending:node?.text==null,sourceHash:node?.source_hash??null,builtAs:node?.built_as??null};
  }
  async sourceTask(job){
    await this.init();if(!this.#currentJob(job))return {stale:true};
    let source,bodyMaxBytes=this.options.maxSummaryBytes;
    if(job.count===1){
      const original=this.#sql('SELECT * FROM tree_originals WHERE chat_id=? AND id=?').get(job.chatId,job.id);
      source=[{id:job.id,count:1,text:original.text,role:original.role,kind:original.kind,date:original.created_at||null,metadata:JSON.parse(original.metadata),prefix:prefix(original)}];
      bodyMaxBytes-=bytes(`${prefix(original)} `);
    }else{
      const half=job.count/2;
      source=[this.#entry(job.chatId,job.id,half),this.#entry(job.chatId,job.id+half,half)];
      if(source.some(entry=>entry.pending))throw Error('A parent requires both completed child summaries.');
    }
    const end=job.count===1?job.id:job.id+job.count;
    // A later completed leaf is not valid chronological context when a prior
    // leaf is unfinished. Pending leaves always remain in both stable views.
    const hole=this.#sql('SELECT n.id FROM tree_nodes n INDEXED BY tree_leaf_pending CROSS JOIN tree_view_entries e ON e.chat_id=n.chat_id AND e.id=n.id AND e.count=n.count WHERE n.chat_id=? AND n.count=1 AND n.text IS NULL AND n.id<? AND e.mode=\'compaction\' ORDER BY n.id LIMIT 1').get(job.chatId,end);
    const contextEnd=hole?.id??end;
    const context=[];let contextBytes=0,before=contextEnd,contextTruncated=false,done=false;
    while(!done){
      const batch=this.#sql('SELECT e.id,e.count,n.text FROM tree_view_entries e JOIN tree_nodes n ON n.chat_id=e.chat_id AND n.id=e.id AND n.count=e.count WHERE e.chat_id=? AND e.mode=\'compaction\' AND e.id<? AND e.id+e.count<=? AND n.text IS NOT NULL ORDER BY e.id DESC LIMIT 128').all(job.chatId,before,contextEnd);
      if(!batch.length)break;
      for(const row of batch){const size=entryBytes(row.id,row.count,row.text);if(contextBytes+size>this.options.compactionHigh){contextTruncated=true;done=true;break;}context.push({...row});contextBytes+=size;before=row.id;}
      if(batch.length<128)done=true;
    }
    context.reverse();
    return {job:{...job},source,context,contextBytes,contextEnd,contextPending:!!hole,contextTruncated,prefix:job.count===1?source[0].prefix:'',maxBytes:this.options.maxSummaryBytes,bodyMaxBytes};
  }
  async commitSummary(job,text,details={}){
    validText(text);text=text.trim();if(!text)throw Error('A chat summary cannot be empty.');await this.init();
    return this.#transaction(()=>{
      if(!this.#currentJob(job))return {committed:false,stale:true};
      if(job.count===1){const original=this.#sql('SELECT role,kind FROM tree_originals WHERE chat_id=? AND id=?').get(job.chatId,job.id);const label=prefix(original);if(!text.startsWith(`${label} `)&&text!==label)text=`${label} ${text}`;}
      if(bytes(text)>this.options.maxSummaryBytes)throw Error(`A chat summary must fit within ${this.options.maxSummaryBytes} UTF-8 bytes, including its role label.`);
      const committed=this.#buildNode(job.chatId,job.id,job.count,text,job.sourceHash,'summary');
      if(committed&&['catchup','on-demand'].includes(details.origin))this.#sql('INSERT INTO tree_summary_commits(chat_id,id,count,origin,provider,model,saved_at) VALUES(?,?,?,?,?,?,?)').run(job.chatId,job.id,job.count,details.origin,String(details.provider||'').slice(0,100),String(details.model||'').slice(0,300),new Date().toISOString());
      this.#settle(job.chatId);
      const queuedReady=this.#chat(job.chatId).ready_count;
      return {committed,stale:!committed,chatId:job.chatId,id:job.id,count:job.count,queuedReady};
    });
  }
  async deferJob(job){
    await this.init();return this.#transaction(()=>{if(!this.#currentJob(job))return {deferred:false,stale:true};this.#sql("UPDATE tree_jobs SET state='ready',token=NULL,last_error=NULL WHERE chat_id=? AND id=? AND count=?").run(job.chatId,job.id,job.count);return {deferred:true};});
  }
  /** Read committed summaries and outstanding jobs only from explicitly allowed chats. */
  async progress(chatIds,{chatId=null,state='saved',offset=0,limit=20}={}){
    if(!Array.isArray(chatIds)||chatIds.length>10000)throw Error('Invalid progress scope.');
    chatIds=[...new Set(chatIds)];for(const id of chatIds)identifier(id,'chat id');
    if(chatId!==null){identifier(chatId,'chat id');if(!chatIds.includes(chatId))throw Error('This chat is unavailable.');}
    if(!['saved','catchup','pending'].includes(state))throw Error('Invalid progress filter.');
    integer(offset,'progress offset',0,10000000);integer(limit,'progress limit',1,50);await this.init();
    const scope=JSON.stringify(chatIds),selected=JSON.stringify(chatId===null?chatIds:[chatId]);
    const chats=this.#sql(`SELECT c.chat_id AS chatId,c.ready_count AS ready,c.running_count AS running,c.failed_count AS failed,
      (SELECT COUNT(*) FROM tree_nodes n WHERE n.chat_id=c.chat_id AND n.built_as='summary') AS saved,
      (SELECT COUNT(*) FROM tree_summary_commits s WHERE s.chat_id=c.chat_id AND s.origin='catchup') AS savedCatchUp
      FROM tree_chats c WHERE c.chat_id IN (SELECT value FROM json_each(?)) ORDER BY c.chat_id`).all(scope).map(row=>({...row,pending:row.ready+row.running+row.failed}));
    const totals=chats.reduce((all,row)=>{for(const key of ['pending','ready','running','failed','saved','savedCatchUp'])all[key]+=row[key];return all;},{pending:0,ready:0,running:0,failed:0,saved:0,savedCatchUp:0});
    let entries,total;
    if(state==='pending'){
      total=chats.filter(row=>chatId===null||row.chatId===chatId).reduce((n,row)=>n+row.pending,0);
      entries=this.#sql(`SELECT chat_id AS chatId,id,count,state,attempts FROM tree_jobs WHERE chat_id IN (SELECT value FROM json_each(?)) ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,chat_id,count,id LIMIT ? OFFSET ?`).all(selected,limit,offset);
    }else{
      total=chats.filter(row=>chatId===null||row.chatId===chatId).reduce((n,row)=>n+(state==='catchup'?row.savedCatchUp:row.saved),0);
      entries=this.#sql(`SELECT n.chat_id AS chatId,n.id,n.count,n.text,s.origin,s.provider,s.model,s.saved_at AS savedAt FROM tree_nodes n LEFT JOIN tree_summary_commits s USING(chat_id,id,count) WHERE n.built_as='summary' AND n.chat_id IN (SELECT value FROM json_each(?)) ${state==='catchup'?"AND s.origin='catchup'":''} ORDER BY COALESCE(s.saved_at,'') DESC,n.chat_id,n.id DESC,n.count DESC LIMIT ? OFFSET ?`).all(selected,limit,offset);
    }
    return {capturedAt:new Date().toISOString(),totals,chats,entries,state,chatId,offset,total,nextOffset:offset+entries.length<total?offset+entries.length:null};
  }
  async failJob(job,error='Summary unavailable.'){
    await this.init();return this.#transaction(()=>{if(!this.#currentJob(job))return {failed:false,stale:true};const generation=this.#chat(job.chatId).generation;const message=String(error?.message??error).slice(0,400);this.#sql("UPDATE tree_jobs SET state='failed',token=NULL,blocked_generation=?,last_error=? WHERE chat_id=? AND id=? AND count=?").run(generation,message,job.chatId,job.id,job.count);return {failed:true,retryAfterEventGeneration:generation};});
  }
  async view(chatId,{kind='turn'}={}){
    identifier(chatId,'chat id');if(!['turn','compaction'].includes(kind))throw Error('Invalid chat memory view.');await this.init();
    const chat=this.#chat(chatId),state=this.#sql('SELECT * FROM tree_views WHERE chat_id=? AND mode=?').get(chatId,kind);
    if(!chat)return {chatId,kind,entries:[],text:'',bytes:0,revision:0,total:0,compacting:false};
    const entries=this.#sql('SELECT id,count FROM tree_view_entries WHERE chat_id=? AND mode=? ORDER BY id').all(chatId,kind).map(row=>this.#entry(chatId,row.id,row.count));
    const text=entries.map(entry=>`${entry.id}+${entry.count} ${entry.text}\n`).join('');
    return {chatId,kind,entries,text,bytes:state.bytes,revision:state.revision,total:chat.next_id,compacting:!!state.compacting,eventGeneration:chat.generation};
  }
  async zoom(chatId,id,count=1,{offset=0,limit=16000}={}){
    identifier(chatId,'chat id');validRange(id,count);integer(offset,'source offset');integer(limit,'source limit',1,32000);await this.init();
    if(!this.#chat(chatId)||id+count>this.#chat(chatId).next_id)throw Error('Chat memory range does not exist.');
    if(count>1){const half=count/2;return {chatId,id,count,children:[this.#entry(chatId,id,half),this.#entry(chatId,id+half,half)]};}
    const row=this.#sql('SELECT * FROM tree_originals WHERE chat_id=? AND id=?').get(chatId,id);
    if(offset>row.text.length||offset>0&&/[\uD800-\uDBFF]/.test(row.text[offset-1])&&/[\uDC00-\uDFFF]/.test(row.text[offset]))throw Error('Source offset exceeds the original or splits a Unicode character.');
    let end=Math.min(row.text.length,offset+limit);if(end<row.text.length&&/[\uD800-\uDBFF]/.test(row.text[end-1])&&/[\uDC00-\uDFFF]/.test(row.text[end]))end--;
    if(end===offset&&offset<row.text.length)end=Math.min(row.text.length,offset+2);
    return {chatId,id,count,eventKey:row.event_key,role:row.role,kind:row.kind,date:row.created_at||null,metadata:JSON.parse(row.metadata),sourceHash:row.source_hash,text:row.text.slice(offset,end),offset,nextOffset:end<row.text.length?end:null,totalCharacters:row.text.length,totalBytes:bytes(row.text)};
  }
  async originals(chatId,{offset=0,limit=128,through}={}){
    identifier(chatId,'chat id');integer(offset,'original cursor');integer(limit,'original page size',1,128);await this.init();
    const chat=this.#chat(chatId),snapshot=through===undefined?chat?.next_id??0:integer(through,'original snapshot');
    if(snapshot>(chat?.next_id??0)||offset>snapshot)throw Error('Original cursor exceeds its chat snapshot.');
    const rows=this.#sql('SELECT id,event_key,role,kind,created_at,text,metadata,source_hash FROM tree_originals WHERE chat_id=? AND id>=? AND id<? ORDER BY id LIMIT ?').all(chatId,offset,snapshot,limit);
    const originals=rows.map(row=>({id:row.id,count:1,eventKey:row.event_key,role:row.role,kind:row.kind,date:row.created_at||null,metadata:JSON.parse(row.metadata),sourceHash:row.source_hash,text:row.text}));
    const next=rows.length?rows.at(-1).id+1:snapshot;
    return {chatId,total:snapshot,snapshot,originals,nextOffset:next<snapshot?next:null};
  }
  async date(chatId,id,count=1){identifier(chatId,'chat id');validRange(id,count);await this.init();const first=this.#sql('SELECT created_at FROM tree_originals WHERE chat_id=? AND id=?').get(chatId,id),last=this.#sql('SELECT created_at FROM tree_originals WHERE chat_id=? AND id=?').get(chatId,id+count-1);if(!first||!last)throw Error('Chat memory range does not exist.');return {chatId,id,count,first:first.created_at||null,last:last.created_at||null};}
  async stats(chatId){
    identifier(chatId,'chat id');await this.init();const chat=this.#chat(chatId);if(!chat)return {chatId,total:0,totalMessages:0,pendingJobs:0,viewBytes:0,compactionBytes:0,overBudget:false,originalBytes:0,nodes:0,builtNodes:0,jobs:{ready:0,running:0,failed:0},views:[]};
    const jobs={ready:chat.ready_count,running:chat.running_count,failed:chat.failed_count};
    const views=this.#sql('SELECT mode AS kind,bytes,compacting,revision FROM tree_views WHERE chat_id=? ORDER BY mode').all(chatId).map(row=>({...row,compacting:!!row.compacting}));
    const viewBytes=views.find(view=>view.kind==='turn').bytes,compactionBytes=views.find(view=>view.kind==='compaction').bytes;
    return {chatId,total:chat.next_id,totalMessages:chat.next_id,pendingJobs:jobs.ready+jobs.running+jobs.failed,viewBytes,compactionBytes,overBudget:viewBytes>this.options.turnHigh||compactionBytes>this.options.compactionHigh,eventGeneration:chat.generation,revision:chat.revision,originalBytes:chat.original_bytes,nodes:chat.node_count,builtNodes:chat.built_count,jobs,views};
  }
  async audit(chatId){
    await this.init();const chat=this.#chat(chatId);if(!chat)return {chatId,valid:true,originals:0,coverage:[]};
    const originals=this.#sql('SELECT id FROM tree_originals WHERE chat_id=? ORDER BY id').all(chatId);
    let valid=originals.length===chat.next_id&&originals.every((row,index)=>row.id===index);const coverage=[];
    for(const kind of ['turn','compaction']){const view=await this.view(chatId,{kind});let next=0;for(const entry of view.entries){if(entry.id!==next)valid=false;next+=entry.count;}if(next!==chat.next_id||bytes(view.text)!==view.bytes)valid=false;coverage.push({kind,covered:next,bytes:view.bytes,entries:view.entries.length});}
    const oversized=this.#sql('SELECT COUNT(*) AS n FROM tree_nodes WHERE chat_id=? AND text IS NOT NULL AND length(CAST(text AS BLOB))>?').get(chatId,this.options.maxSummaryBytes).n;
    return {chatId,valid:valid&&!oversized,originals:originals.length,oversizedNodes:oversized,coverage};
  }
  async removeChat(chatId){identifier(chatId,'chat id');await this.init();return this.#transaction(()=>{this.#sql('DELETE FROM tree_migrations WHERE name=?').run(DETERMINISTIC+chatId);return {chatId,removed:!!this.#sql('DELETE FROM tree_chats WHERE chat_id=?').run(chatId).changes};});}
  async clear(){await this.init();return this.#transaction(()=>({removedChats:this.#sql('DELETE FROM tree_chats').run().changes}));}
  async close(){if(this.#initializing)await this.#initializing;if(this.#db){this.#db.close();this.#db=null;this.#statements.clear();}}
}
