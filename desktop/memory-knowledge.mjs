import {randomUUID,createHash} from 'node:crypto';

const TYPES=['person','organization','project','product','place','system','other'];
const normalize=value=>String(value||'').normalize('NFKC').trim().toLocaleLowerCase('en-US');
const string=(value,label,max=120)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\r\n\0]/.test(value))throw Error(`Use a valid ${label} (up to ${max} characters).`);return value.trim();};
const instant=(value,label)=>{if(value===null||value===undefined||value==='')return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value.slice(0,10))throw Error(`Use an ISO date or UTC timestamp for ${label}.`);return new Date(value).toISOString();};
const LIMIT=500;
const hash=text=>createHash('sha256').update(text).digest('hex');

/** Owner-reviewed annotations over shared original notes. No inferred identity merging. */
export class MemoryKnowledge {
  constructor(db){this.db=db;}
  install(){this.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entities(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,aliases TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_fact_links(note_id TEXT NOT NULL,entity_id TEXT NOT NULL,predicate TEXT NOT NULL,valid_from TEXT,valid_to TEXT,recorded_at TEXT NOT NULL,source_hash TEXT NOT NULL,PRIMARY KEY(note_id,entity_id,predicate));
    CREATE INDEX IF NOT EXISTS memory_fact_entity ON memory_fact_links(entity_id,note_id);
    CREATE TABLE IF NOT EXISTS memory_dependencies(source_id TEXT NOT NULL,dependent_id TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(source_id,dependent_id));
    CREATE INDEX IF NOT EXISTS memory_dependents ON memory_dependencies(source_id);
  `);}
  entity(row){return row?{id:row.id,type:row.type,name:row.name,aliases:JSON.parse(row.aliases),recordedAt:row.recorded_at}:null;}
  liveNote(id){return this.db.prepare('SELECT id,seq,text,created_at AS createdAt FROM notes WHERE id=? AND deleted=0').get(id);}
  change(){this.db.exec('UPDATE memory_meta SET revision=revision+1 WHERE id=1');}
  entities(){return this.db.prepare('SELECT * FROM memory_entities ORDER BY name,id LIMIT 1001').all().map(row=>this.entity(row));}
  define(input){
    const type=string(input.type,'entity type');if(!TYPES.includes(type))throw Error('Choose person, organization, project, product, place, system or other.');
    const name=string(input.name,'entity name');if(input.aliases!==undefined&&!Array.isArray(input.aliases))throw Error('Aliases must be a list.');
    const aliases=[...new Map((input.aliases||[]).map(value=>{const alias=string(value,'alias');return [normalize(alias),alias];})).values()].filter(value=>normalize(value)!==normalize(name));
    if(aliases.length>20)throw Error('Use at most 20 explicit aliases.');
    const existing=input.id?this.db.prepare('SELECT * FROM memory_entities WHERE id=?').get(input.id):null;
    if(input.id&&!existing)throw Error('Entity not found.');
    if(!existing&&this.entities().length>=1000)throw Error('The local entity index is limited to 1000 entities.');
    const id=existing?.id||randomUUID(),at=new Date().toISOString();
    this.db.prepare('INSERT INTO memory_entities VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,name=excluded.name,aliases=excluded.aliases,recorded_at=excluded.recorded_at').run(id,type,name,JSON.stringify(aliases),at);this.change();
    return this.entity(this.db.prepare('SELECT * FROM memory_entities WHERE id=?').get(id));
  }
  link(input){
    const noteId=string(input.noteId,'note ID'),entityId=string(input.entityId,'entity ID'),predicate=string(input.predicate,'fact label',80);
    const note=this.liveNote(noteId);if(!note)throw Error('Choose an existing shared note.');
    if(!this.db.prepare('SELECT 1 FROM memory_entities WHERE id=?').get(entityId))throw Error('Entity not found.');
    const count=this.db.prepare('SELECT COUNT(*) AS n FROM memory_fact_links WHERE note_id=?').get(noteId).n;
    if(count>=30&&!this.db.prepare('SELECT 1 FROM memory_fact_links WHERE note_id=? AND entity_id=? AND predicate=?').get(noteId,entityId,predicate))throw Error('A note can have at most 30 fact annotations.');
    const validFrom=instant(input.validFrom,'valid from'),validTo=instant(input.validTo,'valid to');if(validFrom&&validTo&&validFrom>=validTo)throw Error('Valid until must follow valid from.');
    const at=new Date().toISOString();this.db.prepare('INSERT INTO memory_fact_links VALUES(?,?,?,?,?,?,?) ON CONFLICT(note_id,entity_id,predicate) DO UPDATE SET valid_from=excluded.valid_from,valid_to=excluded.valid_to,recorded_at=excluded.recorded_at,source_hash=excluded.source_hash').run(noteId,entityId,predicate,validFrom,validTo,at,hash(note.text));this.change();return {linked:true,noteId,entityId,predicate,validFrom,validTo,recordedAt:at};
  }
  unlink(input){this.db.prepare('DELETE FROM memory_fact_links WHERE note_id=? AND entity_id=? AND predicate=?').run(string(input.noteId,'note ID'),string(input.entityId,'entity ID'),string(input.predicate,'fact label',80));this.change();return {removed:true};}
  forget(input){const id=string(input.id,'entity ID');this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM memory_fact_links WHERE entity_id=?').run(id);this.db.prepare('DELETE FROM memory_entities WHERE id=?').run(id);this.change();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}return {removed:true,originalNotesPreserved:true};}
  depends(input){
    const sourceId=string(input.sourceId,'source note ID'),dependentId=string(input.dependentId,'dependent note ID');
    if(sourceId===dependentId||!this.liveNote(sourceId)||!this.liveNote(dependentId))throw Error('Choose two different existing shared notes.');
    if(input.remove===true){this.db.prepare('DELETE FROM memory_dependencies WHERE source_id=? AND dependent_id=?').run(sourceId,dependentId);this.change();return {removed:true};}
    const cycle=this.db.prepare('WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT d.dependent_id FROM memory_dependencies d JOIN chain c ON d.source_id=c.id) SELECT 1 FROM chain WHERE id=?').get(dependentId,sourceId);
    if(cycle)throw Error('This dependency would create a cycle.');
    this.db.prepare('INSERT OR IGNORE INTO memory_dependencies VALUES(?,?,?)').run(sourceId,dependentId,new Date().toISOString());this.change();return {linked:true,sourceId,dependentId};
  }
  matches(query){
    const q=normalize(query);if(!q)return [];
    const spans=part=>{const found=[];let start=q.indexOf(part);while(start!==-1){const before=q[start-1],after=q[start+part.length];if((!before||!/[\p{L}\p{N}_]/u.test(before))&&(!after||!/[\p{L}\p{N}_]/u.test(after)))found.push({start,end:start+part.length});start=q.indexOf(part,start+1);}return found;};
    const candidates=this.entities().map(item=>({...item,bindings:[{text:item.name,kind:'name'},...item.aliases.map(text=>({text,kind:'alias'}))].flatMap(binding=>spans(normalize(binding.text)).map(span=>({...binding,...span})))}));
    // An alias inside a fully named different entity is not a second identity lookup.
    // A separate mention outside that full name still preserves genuine ambiguity.
    const canonical=candidates.flatMap(item=>item.bindings.filter(binding=>binding.kind==='name').map(binding=>({...binding,id:item.id})));
    return candidates.map(item=>({...item,bindings:item.bindings.filter(binding=>binding.kind==='name'||!canonical.some(other=>other.id!==item.id&&other.start<=binding.start&&other.end>=binding.end&&other.end-other.start>binding.end-binding.start))})).filter(item=>item.bindings.length).map(({bindings,...item})=>({...item,matchedAs:[...new Map(bindings.map(({text,kind})=>[`${kind}:${text}`,{text,kind}])).values()]}));
  }
  links(noteId,{asOf}={}){
    const at=asOf?instant(asOf,'as of'):new Date().toISOString();
    return this.db.prepare('SELECT f.*,e.type,e.name,e.aliases AS entity_aliases,n.text AS source_text FROM memory_fact_links f JOIN memory_entities e ON e.id=f.entity_id JOIN notes n ON n.id=f.note_id AND n.deleted=0 WHERE f.note_id=? ORDER BY e.name,f.predicate LIMIT 30').all(noteId).map(row=>({entity:{id:row.entity_id,type:row.type,name:row.name,aliases:JSON.parse(row.entity_aliases)},predicate:row.predicate,validFrom:row.valid_from,validTo:row.valid_to,recordedAt:row.recorded_at,at,stale:row.source_hash!==hash(row.source_text),applicable:row.source_hash===hash(row.source_text)&&(!row.valid_from||row.valid_from<=at)&&(!row.valid_to||at<row.valid_to),basis:'owner-recorded annotation; not external verification'}));
  }
  candidates(query,{asOf}={}){
    const entities=this.matches(query),rows=new Map();
    if(asOf)instant(asOf,'as of');
    for(const entity of entities)for(const note of this.db.prepare('SELECT n.id,n.seq,n.created_at AS date,n.text,n.reviewed FROM memory_fact_links f JOIN notes n ON n.id=f.note_id AND n.deleted=0 WHERE f.entity_id=? ORDER BY n.seq DESC LIMIT ?').all(entity.id,LIMIT)){
      const facts=this.links(note.id,{asOf}).filter(link=>entities.some(item=>item.id===link.entity.id)).map(link=>({...link,entity:{...link.entity,matchedAs:entities.find(item=>item.id===link.entity.id).matchedAs}}));if(asOf&&!facts.some(fact=>fact.applicable))continue;
      rows.set(note.id,{...note,knowledge:facts});
    }
    return {entities,ambiguous:entities.length>1,notes:[...rows.values()].slice(0,LIMIT)};
  }
  inspect({query='',noteId,asOf,offset=0,limit=20}={}){
    if(!Number.isSafeInteger(offset)||offset<0||offset>2000||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Choose a valid knowledge page (offset 0 to 2000, limit 1 to 50).');
    if(noteId&&!this.liveNote(noteId))throw Error('Shared note not found.');
    const matched=query?this.candidates(query,{asOf}):{entities:this.entities(),notes:[],ambiguous:false};
    const dependencies=noteId?this.impact(noteId):[];
    const entries=[...matched.entities.map(value=>({kind:'entity',value})),...matched.notes.map(value=>({kind:'note',value}))],entities=[],notes=[];let chars=0,count=0;
    for(const item of entries.slice(offset,offset+limit)){const size=JSON.stringify(item.value).length;if(count&&chars+size>24000)break;(item.kind==='entity'?entities:notes).push(item.value);chars+=size;count++;}
    const next=offset+count;
    return {...matched,entities,notes,offset,totalEntities:matched.entities.length,totalNotes:matched.notes.length,nextOffset:next<entries.length?next:null,...(noteId?{note:this.liveNote(noteId),facts:this.links(noteId,{asOf}),dependents:dependencies.slice(0,50)}:{}),types:TYPES,notice:'Explicit shared-note annotations. Aliases may refer to several entities; ambiguity is preserved. Validity is owner-recorded, not inferred from note age. Dependencies identify review impact, never authorize execution.'};
  }
  impact(noteId){return this.db.prepare('WITH RECURSIVE chain(id) AS (SELECT dependent_id FROM memory_dependencies WHERE source_id=? UNION SELECT d.dependent_id FROM memory_dependencies d JOIN chain c ON d.source_id=c.id) SELECT n.id,n.seq,n.text,n.created_at AS createdAt FROM chain c JOIN notes n ON n.id=c.id AND n.deleted=0 ORDER BY n.seq DESC LIMIT ?').all(noteId,LIMIT);}
}
