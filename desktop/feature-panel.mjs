import {parseDocument} from 'htmlparser2';
const tags=new Set('article section div span p h1 h2 h3 h4 h5 h6 strong em b i small pre code ul ol li dl dt dd br hr table thead tbody tr th td details summary img'.split(' '));
const drop=new Set('script style iframe object embed link meta base template noscript'.split(' '));
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function featurePanelSource(html){
  if(typeof html!=='string'||html.length>128*1024)throw Error('Feature panels must fit within 128 KiB.');
  let count=0;function render(node,depth=0){if(++count>3000||depth>30)return '';if(node.type==='text')return escape(node.data);if(drop.has(node.name))return '';const children=(node.children||[]).map(child=>render(child,depth+1)).join('');if(!tags.has(node.name))return children;
    const attributes=Object.entries(node.attribs||{}).filter(([key,value])=>['class','style','title','role','aria-label','alt','width','height'].includes(key)||key==='src'&&node.name==='img'&&/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)).map(([key,value])=>` ${key}="${escape(value)}"`).join('');return `<${node.name}${attributes}>${children}${['br','hr','img'].includes(node.name)?'':`</${node.name}>`}`;
  }
  const body=parseDocument(html).children.map(node=>render(node)).join('');
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><style>body{font:14px system-ui;color:#eee;background:#171b22;padding:12px;overflow-wrap:anywhere}img{max-width:100%}</style>${body}`;
}
