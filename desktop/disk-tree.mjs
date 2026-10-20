// Compact folder tree for a storage scan: typed arrays instead of one object per folder, so a
// drive with millions of folders stays small and can move between threads without copying.
import path from 'node:path';

const FLAG_UNREADABLE=1,FLAG_UNFINISHED=2,FLAG_SUBTREE=4;
const grow=(array,size)=>{if(array.length>=size)return array;const next=new array.constructor(Math.max(size,array.length*2||1024));next.set(array);return next;};

export class TreeBuilder{
 constructor(){this.count=0;this.parent=new Int32Array(1024);this.metrics=['bytes','alloc','files','directBytes','directAlloc','directFiles'].reduce((all,key)=>({...all,[key]:new Float64Array(1024)}),{});this.flags=new Uint8Array(1024);this.nameOffsets=new Uint32Array(1025);this.names=Buffer.alloc(1<<16);this.nameLength=0;}
 add({parent,name,bytes,alloc,files,directBytes,directAlloc,directFiles,flags}){
  const index=this.count++,size=this.count;
  this.parent=grow(this.parent,size);this.flags=grow(this.flags,size);this.nameOffsets=grow(this.nameOffsets,size+1);
  for(const key of Object.keys(this.metrics))this.metrics[key]=grow(this.metrics[key],size);
  const encoded=Buffer.from(String(name),'utf8');
  if(this.nameLength+encoded.length>this.names.length){const next=Buffer.alloc(Math.max(this.names.length*2,this.nameLength+encoded.length));this.names.copy(next,0,0,this.nameLength);this.names=next;}
  encoded.copy(this.names,this.nameLength);this.nameOffsets[index]=this.nameLength;this.nameLength+=encoded.length;this.nameOffsets[size]=this.nameLength;
  this.parent[index]=parent;this.flags[index]=flags|0;
  this.metrics.bytes[index]=bytes;this.metrics.alloc[index]=alloc;this.metrics.files[index]=files;this.metrics.directBytes[index]=directBytes;this.metrics.directAlloc[index]=directAlloc;this.metrics.directFiles[index]=directFiles;
  return index;
 }
 finish(){
  const n=this.count,start=new Uint32Array(n+1),ids=new Uint32Array(Math.max(0,n-1));
  for(let i=1;i<n;i++)start[this.parent[i]+1]++;
  for(let i=0;i<n;i++)start[i+1]+=start[i];
  const cursor=start.slice(0,n);for(let i=1;i<n;i++)ids[cursor[this.parent[i]]++]=i;
  return {count:n,parent:this.parent.slice(0,n),flags:this.flags.slice(0,n),nameOffsets:this.nameOffsets.slice(0,n+1),names:new Uint8Array(this.names.buffer,this.names.byteOffset,this.nameLength).slice(),childStart:start,childIds:ids,...Object.fromEntries(Object.entries(this.metrics).map(([key,array])=>[key,array.slice(0,n)]))};
 }
}

export class ScanTree{
 constructor(data){Object.assign(this,data);this.nameBuffer=Buffer.from(this.names.buffer,this.names.byteOffset,this.names.byteLength);}
 get size(){return this.count;}
 name(index){return this.nameBuffer.toString('utf8',this.nameOffsets[index],this.nameOffsets[index+1]);}
 path(index){
  const parts=[];for(let at=index;at>=0;at=this.parent[at]===-1?-1:this.parent[at])parts.unshift(this.name(at));
  return parts.length===1?parts[0]:parts.reduce((all,part)=>all.endsWith('\\')||all.endsWith('/')?all+part:all+path.sep+part);
 }
 children(index){return Array.from(this.childIds.subarray(this.childStart[index],this.childStart[index+1]));}
 childCount(index){return this.childStart[index+1]-this.childStart[index];}
 complete(index){return (this.flags[index]&(FLAG_UNREADABLE|FLAG_UNFINISHED|FLAG_SUBTREE))===0;}
 /** Plain object for one folder; `path` is built only when somebody asks for it. */
 node(index,{withPath=true}={}){
  return {id:String(index),parent:this.parent[index]<0?null:String(this.parent[index]),name:this.name(index),...(withPath?{path:this.path(index)}:{}),bytes:this.bytes[index],alloc:this.alloc[index],files:this.files[index],directBytes:this.directBytes[index],directAlloc:this.directAlloc[index],directFiles:this.directFiles[index],scanned:(this.flags[index]&FLAG_UNFINISHED)===0,complete:this.complete(index),inaccessible:(this.flags[index]&FLAG_UNREADABLE)!==0};
 }
 /** Finds a folder by absolute path (case-insensitive, as Windows does). */
 find(target){
  const root=this.name(0).replace(/[\\/]+$/,'').replaceAll('/','\\').toLowerCase(),wanted=String(target).replace(/[\\/]+$/,'').replaceAll('/','\\');
  const lowered=wanted.toLowerCase();if(lowered===root)return 0;if(!lowered.startsWith(root+'\\'))return -1;
  let at=0;for(const part of wanted.slice(root.length+1).split(/[\\/]+/).filter(Boolean)){
   const key=part.toLowerCase();let next=-1;for(let i=this.childStart[at];i<this.childStart[at+1];i++){const child=this.childIds[i];if(this.name(child).toLowerCase()===key){next=child;break;}}
   if(next<0)return -1;at=next;
  }
  return at;
 }
 /** Outermost folders whose name is in `names` (lowercase), summed without double counting. */
 groupByName(names){
  const out=new Map(),stack=[0];
  while(stack.length){
   const at=stack.pop(),own=at>0?this.name(at).toLowerCase():'';
   if(at>0&&names.has(own)){const row=out.get(own)||{name:own,alloc:0,bytes:0,files:0,count:0,examples:[]};row.alloc+=this.alloc[at];row.bytes+=this.bytes[at];row.files+=this.files[at];row.count++;row.examples.push({id:at,alloc:this.alloc[at]});out.set(own,row);continue;}
   for(let i=this.childStart[at];i<this.childStart[at+1];i++)stack.push(this.childIds[i]);
  }
  for(const row of out.values()){row.examples=row.examples.sort((a,b)=>b.alloc-a.alloc).slice(0,3).map(item=>this.path(item.id));}
  return [...out.values()];
 }
 get transferables(){return [this.parent,this.flags,this.nameOffsets,this.names,this.childStart,this.childIds,this.bytes,this.alloc,this.files,this.directBytes,this.directAlloc,this.directFiles].map(array=>array.buffer);}
 get data(){const {count,parent,flags,nameOffsets,names,childStart,childIds,bytes,alloc,files,directBytes,directAlloc,directFiles}=this;return {count,parent,flags,nameOffsets,names,childStart,childIds,bytes,alloc,files,directBytes,directAlloc,directFiles};}
}

/** Builds a tree from the JavaScript walker's folder objects (parents always precede children). */
export function treeFromNodes(nodes){
 const builder=new TreeBuilder();
 for(const item of nodes)builder.add({parent:item.parent===null?-1:Number(item.parent),name:item.parent===null&&item.path?item.path:item.name,bytes:item.bytes,alloc:item.bytes,files:item.files,directBytes:item.directBytes,directAlloc:item.directBytes,directFiles:item.directFiles??0,flags:(item.inaccessible?FLAG_UNREADABLE:0)|(item.scanned?0:FLAG_UNFINISHED)|(item.complete?0:FLAG_SUBTREE)});
 return builder.finish();
}
export {FLAG_UNREADABLE,FLAG_UNFINISHED,FLAG_SUBTREE};
