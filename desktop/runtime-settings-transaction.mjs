const trackers=new WeakMap();
const forbidden=new Set(['__proto__','prototype','constructor']);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const key=parts=>JSON.stringify(parts);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function leaves(value,parts,result){
  if(plain(value)&&Object.keys(value).length){for(const name of Object.keys(value)){if(forbidden.has(name))throw Error('Invalid settings field.');leaves(value[name],[...parts,name],result);}}
  else result.push(parts);
}
function read(settings,parts){
  let value=settings;
  for(const part of parts){if(!value||typeof value!=='object'||!Object.hasOwn(value,part))return {exists:false};value=value[part];}
  return {exists:true,value:structuredClone(value)};
}
function restore(settings,parts,before){
  let target=settings;
  for(const part of parts.slice(0,-1)){if(!plain(target[part]))target[part]={};target=target[part];}
  if(before.exists)target[parts.at(-1)]=structuredClone(before.value);else delete target[parts.at(-1)];
}

/** Settings saves can overlap; roll back only fields this failed save still owns. */
export function beginSettingsTransaction(settings,payload){
  if(!plain(settings)||!plain(payload))throw Error('Invalid settings transaction.');
  let tracker=trackers.get(settings);if(!tracker){tracker={sequence:0,versions:new Map(),active:new Set()};trackers.set(settings,tracker);}
  const paths=[];
  for(const name of Object.keys(payload)){if(forbidden.has(name))throw Error('Invalid settings field.');leaves(payload[name],[name==='voicePatch'?'voice':name],paths);}
  // Theme normalization can clear a custom palette even in a theme-only patch.
  // A later explicit palette also depends on the current theme, so retain that
  // dependency when an older failed theme save attempts rollback.
  if(plain(payload.appearance)){
    if(Object.hasOwn(payload.appearance,'theme')&&!Object.hasOwn(payload.appearance,'customPalette'))paths.push(['appearance','customPalette']);
    if(plain(payload.appearance.customPalette)&&!Object.hasOwn(payload.appearance,'theme'))paths.push(['appearance','theme']);
  }
  const unique=[...new Map(paths.map(parts=>[key(parts),parts])).values()],revision=++tracker.sequence;
  tracker.active.add(revision);
  const finish=()=>{tracker.active.delete(revision);if(!tracker.active.size)tracker.versions.clear();};
  const entries=unique.map(parts=>({parts,key:key(parts),before:read(settings,parts),previous:tracker.versions.get(key(parts))||0}));
  for(const entry of entries)tracker.versions.set(entry.key,revision);
  let ended=false;
  return {
    commit(){ended=true;finish();},
    async rollback({persist=async()=>{},onRestore=()=>{}}={}){
      if(ended)return {restored:0,preserved:0};ended=true;let restored=0,preserved=0;
      for(const entry of entries){
        const newer=[...tracker.versions.entries()].some(([encoded,version])=>{if(version<=revision)return false;const other=JSON.parse(encoded);return entry.parts.every((part,index)=>other[index]===part)||other.every((part,index)=>entry.parts[index]===part);});
        if(tracker.versions.get(entry.key)!==revision||newer){preserved++;continue;}
        if(!equal(read(settings,entry.parts),entry.before)){restore(settings,entry.parts,entry.before);restored++;}
        // Failed/no-op overlapping edits must not strand an earlier tentative value.
        tracker.versions.set(entry.key,entry.previous);
      }
      try{if(restored){onRestore();await persist();}return {restored,preserved};}finally{finish();}
    },
  };
}
