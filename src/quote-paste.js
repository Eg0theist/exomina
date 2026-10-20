/** Continue a Markdown blockquote when a multiline clipboard paste starts in it. */
export function quotePaste(value,start,end,text){
 if(typeof text!=='string'||!/[\r\n]/.test(text))return null;
 const lineStart=value.lastIndexOf('\n',Math.max(0,start-1))+1;
 const line=value.slice(lineStart,value.indexOf('\n',lineStart)<0?value.length:value.indexOf('\n',lineStart));
 const prefix=line.match(/^ {0,3}(?:>[ \t]?)+[ \t]*/)?.[0];
 if(!prefix||start<lineStart+prefix.length)return null;
 let fence=null;
 for(const row of value.slice(0,lineStart).split('\n')){
  const match=row.match(/^ {0,3}(`{3,}|~{3,})/);if(!match)continue;
  if(!fence)fence=match[1];else if(match[1][0]===fence[0]&&match[1].length>=fence.length)fence=null;
 }
 if(fence)return null;
 const depth=(prefix.match(/>/g)||[]).length;
 const lines=text.replace(/\r\n?/g,'\n').split('\n');
 const unquote=row=>{const marker=row.match(/^ {0,3}(?:>[ \t]?)+[ \t]*/)?.[0];return marker&&(marker.match(/>/g)||[]).length===depth?row.slice(marker.length):row;};
 const inserted=lines.map((row,index)=>(index?prefix:'')+unquote(row)).join('\n');
 return {value:value.slice(0,start)+inserted+value.slice(end),caret:start+inserted.length,insert:inserted};
}
