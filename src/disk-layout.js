/** Weighted binary partition: every tile's area equals its share of measured bytes. */
export function diskLayout(rows){
 const items=rows.filter(row=>Number.isFinite(row.bytes)&&row.bytes>0),out=[];
 function split(list,x,y,w,h){
  if(!list.length)return;
  if(list.length===1){out.push({...list[0],x,y,w,h});return;}
  const total=list.reduce((sum,row)=>sum+row.bytes,0);let index=1,weight=list[0].bytes;
  while(index<list.length-1&&Math.abs(weight+list[index].bytes-total/2)<Math.abs(weight-total/2)){weight+=list[index].bytes;index++;}
  const share=weight/total;
  if(w>=h){split(list.slice(0,index),x,y,w*share,h);split(list.slice(index),x+w*share,y,w*(1-share),h);}
  else {split(list.slice(0,index),x,y,w,h*share);split(list.slice(index),x,y+h*share,w,h*(1-share));}
 }
 split(items,0,0,100,100);return out;
}
