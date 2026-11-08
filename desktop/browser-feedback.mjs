import {randomUUID} from 'node:crypto';
import {browserDeadline} from './browser-runtime.mjs';

// Runs in the untrusted page. Return a small, reconstructed snippet, never the
// original outerHTML (which can contain hidden state, handlers and field values).
export function elementFeedbackAt(x,y){
  let element=document.elementFromPoint(x,y);
  while(element?.shadowRoot?.elementFromPoint){const child=element.shadowRoot.elementFromPoint(x,y);if(!child||child===element)break;element=child;}
  if(!element||element.closest('input,textarea,select,[contenteditable],iframe'))throw Error('Choose a page element outside editable fields and embedded frames.');
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let nodes=0;
  function snippet(node,depth=0){
    if(++nodes>60||depth>5)return '';
    if(node.nodeType===3)return escape((node.textContent||'').slice(0,500));
    if(node.nodeType!==1||/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|EMBED|INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName)||node.hidden||node.getAttribute('aria-hidden')==='true'||node.isContentEditable)return '';
    const visibility=getComputedStyle(node);if(visibility.display==='none'||visibility.visibility==='hidden'||visibility.opacity==='0')return '';
    const tag=node.tagName.toLowerCase();
    const attributes=['id','class','role'].map(key=>{const value=node.getAttribute(key);return value?` ${key}="${escape(value.slice(0,200))}"`:'';}).join('');
    return `<${tag}${attributes}>${Array.from(node.childNodes).map(child=>snippet(child,depth+1)).join('')}</${tag}>`;
  }
  const rect=element.getBoundingClientRect(),computed=getComputedStyle(element);
  const keys=['display','position','width','height','padding','margin','color','background-color','font-family','font-size','font-weight','line-height','border','border-radius','gap','align-items','justify-content'];
  const styles=Object.fromEntries(keys.map(key=>[key,computed.getPropertyValue(key).slice(0,250)]));
  const box={x:Math.max(0,Math.floor(rect.x)),y:Math.max(0,Math.floor(rect.y)),width:Math.max(0,Math.min(innerWidth,Math.ceil(rect.right))-Math.max(0,Math.floor(rect.x))),height:Math.max(0,Math.min(innerHeight,Math.ceil(rect.bottom))-Math.max(0,Math.floor(rect.y)))};
  const editable=Array.from(document.querySelectorAll('input,textarea,select,[contenteditable],iframe')).some(node=>{const r=node.getBoundingClientRect();return r.width&&r.height&&r.left<box.x+box.width&&r.right>box.x&&r.top<box.y+box.height&&r.bottom>box.y;});
  return {tag:element.tagName.toLowerCase(),html:snippet(element).slice(0,6000),styles,box,screenshotAllowed:!editable&&box.width>0&&box.height>0&&box.width*box.height<=2_000_000};
}

export function feedbackUrl(value){const url=new URL(value);if(!['https:','http:'].includes(url.protocol))throw Error('Choose an element on a web page.');url.username='';url.password='';url.search='';url.hash='';return url.href;}

export class BrowserFeedback {
  constructor(page){this.page=page;this.pending=new Map();}
  async capture(x,y){
    const p=this.page;if(!p.getSettings().browserEnabled)throw Error('Browser tools are off. Enable them in Tools.');
    const revision=p.runtime.revision,url=p.wc.getURL();
    const assert=()=>{if(p.wc.isDestroyed()||!p.getSettings().browserEnabled||p.runtime.revision!==revision||p.wc.getURL()!==url)throw Error('The page changed. Select the element again.');};
    const cleanUrl=feedbackUrl(url);assert();
    if(typeof p.wc.executeJavaScriptInIsolatedWorld!=='function')throw Error('This browser does not support isolated element inspection.');
    const value=await browserDeadline(()=>p.wc.executeJavaScriptInIsolatedWorld(1004,[{code:`(${elementFeedbackAt.toString()})(${Number(x)},${Number(y)})`}]),{milliseconds:4000,message:'Element inspection timed out.'});assert();
    const styles=Object.fromEntries(['display','position','width','height','padding','margin','color','background-color','font-family','font-size','font-weight','line-height','border','border-radius','gap','align-items','justify-content'].filter(key=>typeof value.styles?.[key]==='string').map(key=>[key,value.styles[key].slice(0,250)]));
    const box=value.box,validBox=box&&['x','y','width','height'].every(key=>Number.isInteger(box[key])&&box[key]>=0)&&box.width>0&&box.height>0&&box.width<=4096&&box.height<=4096&&box.width*box.height<=2_000_000;
    let image=null;
    let screenshotSafe=false;
    if(value.screenshotAllowed===true&&validBox&&p.wc.getZoomFactor()===1)try{screenshotSafe=await p.withDebugger(async send=>{
      const target=await send('DOM.getNodeForLocation',{x:Math.round(x),y:Math.round(y),includeUserAgentShadowDOM:true});
      const {node}=await send('DOM.describeNode',{backendNodeId:target.backendNodeId,depth:8,pierce:true});
      let visited=0;const safe=node=>{if(!node||++visited>300||node.shadowRoots?.length||/^(?:INPUT|TEXTAREA|SELECT|IFRAME|OBJECT|EMBED)$/.test(node.nodeName)||node.attributes?.some((value,index)=>index%2===0&&value==='contenteditable')||(node.childNodeCount||0)>(node.children?.length||0))return false;return (node.children||[]).every(safe);};
      if(!safe(node))return false;
      const {model}=await send('DOM.getBoxModel',{backendNodeId:target.backendNodeId});const quad=model.border;return Math.abs(Math.floor(quad[0])-box.x)<=1&&Math.abs(Math.floor(quad[1])-box.y)<=1&&Math.abs(Math.ceil(quad[4])-box.x-box.width)<=1&&Math.abs(Math.ceil(quad[5])-box.y-box.height)<=1;
    });}catch{}
    if(screenshotSafe){const captured=await browserDeadline(()=>p.wc.capturePage(box),{milliseconds:2500,message:'Element image capture timed out.'});assert();if(!captured.isEmpty())image=captured.resize({width:Math.min(720,captured.getSize().width)}).toDataURL();if(image?.length>1_500_000)image=null;}
    const id=randomUUID(),record={id,url:cleanUrl,tag:String(value.tag).slice(0,50),html:String(value.html).slice(0,6000),styles,image,revision,createdAt:Date.now()};
    this.pending.clear();this.pending.set(id,{record,assert});return record;
  }
  take(id){const item=this.pending.get(id);if(!item||Date.now()-item.record.createdAt>10*60_000)throw Error('This element capture expired. Select it again.');item.assert();this.pending.delete(id);return item.record;}
  clear(){this.pending.clear();}
}
