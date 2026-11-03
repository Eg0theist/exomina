/** CDP input shared by the built-in browser and paired extension. DOM is used
 * to locate, focus, select and verify. Values are edited through native Input. */
const check=(expiresAt,signal)=>{if(signal?.aborted)throw Error('The browser action was stopped.');if(Date.now()>expiresAt)throw Error('This browser action expired.');};
function value(result){if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Browser input failed.');return result.result;}
// Emulate renderer focus only. No OS activation, view attachment or tab selection.
// The owning debugger session is exclusive and its focus override is scoped.
async function withInputFocus(send,operation){
 await send('Emulation.setFocusEmulationEnabled',{enabled:true});
 try{return await operation();}
 finally{await send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});}
}
export async function trustedKey(send,{input,expiresAt},signal,keyboard){
 const codes={Enter:13,Tab:9,Escape:27,ArrowDown:40,ArrowUp:38,ArrowLeft:37,ArrowRight:39,Backspace:8};
 if(!Object.hasOwn(codes,input?.key))throw Error('Unsupported key');
 check(expiresAt,signal);
 return withInputFocus(send,async()=>{
  check(expiresAt,signal);
  if(keyboard)await keyboard(input.key);
  else{
   await send('Input.dispatchKeyEvent',{type:'keyDown',key:input.key,code:input.key,windowsVirtualKeyCode:codes[input.key],...(input.key==='Enter'?{text:'\r'}:{})});
   await send('Input.dispatchKeyEvent',{type:'keyUp',key:input.key,code:input.key,windowsVirtualKeyCode:codes[input.key]});
  }
  await new Promise(resolve=>setTimeout(resolve,150));
  check(expiresAt,signal);
 });
}
export async function trustedInput(send,{action,input,expiresAt},signal,pointer){
 if(!['click','type'].includes(action)||typeof input.selector!=='string'||!input.selector||input.selector.length>1000)throw Error('A valid browser input action and selector are required.');
 if(action==='type'&&(typeof input.text!=='string'||input.text.length>16000))throw Error('Text is too long.');
 check(expiresAt,signal);
 return withInputFocus(send,async()=>{
 let objectId,documentId;
 const command=async(method,args)=>{check(expiresAt,signal);return send(method,args);};
 const call=async(fn,args=[])=>value(await command('Runtime.callFunctionOn',{objectId,functionDeclaration:fn.toString(),arguments:args.map(value=>({value})),returnByValue:true,awaitPromise:true})).value;
 try{
  documentId=value(await command('Runtime.evaluate',{expression:'document',returnByValue:false})).objectId;
  if(!documentId)throw Error('The browser document is unavailable.');
  const target=value(await command('Runtime.callFunctionOn',{objectId:documentId,functionDeclaration:function(selector,deadline){if(Date.now()>deadline)throw Error('This browser action expired.');const found=this.querySelectorAll(selector);if(found.length!==1)throw Error('The target is missing or ambiguous. Read a fresh browser snapshot.');return found[0];}.toString(),arguments:[{value:input.selector},{value:expiresAt}],returnByValue:false}));
  objectId=target.objectId;if(!objectId)throw Error('The browser target is unavailable.');
  const point=await call(function(action){
   if(!this.isConnected)throw Error('The target was replaced. Read a fresh snapshot.');
   if(this.disabled||this.closest('[inert]')||this.getAttribute('aria-disabled')==='true')throw Error('The target is disabled.');
   if(action==='type'&&(!this.isContentEditable&&!['INPUT','TEXTAREA'].includes(this.tagName)||this.readOnly||this.tagName==='INPUT'&&!['text','search','email','url','tel','password','number'].includes(this.type)))throw Error('The target is not an editable text field.');
   this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
   const r=this.getBoundingClientRect(),style=getComputedStyle(this);
   if(!this.getClientRects().length||style.visibility==='hidden'||style.display==='none'||r.width<=0||r.height<=0||r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight)throw Error('The target is not visible.');
   // Responsive forms can clip a wide field inside a narrow ancestor. Its
   // bounding-box centre then hits the surrounding page, despite an exposed
   // editable area. Intersect clipping ancestors before native hit testing.
   let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
   for(let parent=this.parentElement;parent;parent=parent.parentElement){
    const css=getComputedStyle(parent),box=parent.getBoundingClientRect();
    if(/^(hidden|clip|auto|scroll)$/.test(css.overflowX)){left=Math.max(left,box.left+parent.clientLeft);right=Math.min(right,box.left+parent.clientLeft+parent.clientWidth);}
    if(/^(hidden|clip|auto|scroll)$/.test(css.overflowY)){top=Math.max(top,box.top+parent.clientTop);bottom=Math.min(bottom,box.top+parent.clientTop+parent.clientHeight);}
   }
   if(right<=left||bottom<=top)throw Error('The target is not visible.');
   const point={x:(left+right)/2,y:(top+bottom)/2},hit=document.elementFromPoint(point.x,point.y);
   if(!hit||hit!==this&&!this.contains(hit))throw Error('The target is covered by another element.');
   return point;
  },[action]);
  if(action==='click'){
   if(pointer){check(expiresAt,signal);await pointer(point);}
   else{
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
   }
   await new Promise(resolve=>setTimeout(resolve,150));check(expiresAt,signal);
   return {route:'trusted',dispatched:true,notice:'A real pointer click was dispatched. Inspect the page to verify the intended effect.'};
  }
  await call(function(){
   if(!this.isConnected)throw Error('The target was replaced before typing.');
   this.focus({preventScroll:true});
   if(document.activeElement!==this&&!this.contains(document.activeElement))throw Error('The target could not receive focus.');
   if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r);}else this.select();
  });
  if(input.text)await command('Input.insertText',{text:input.text});
  else{
   await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
   await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  }
  // Host timers keep this bounded even when Chromium throttles a hidden pane.
  await new Promise(resolve=>setTimeout(resolve,150));
  const verified=await call(function(expected){
   if(!this.isConnected)throw Error('The input was replaced; its value cannot be verified. Read a fresh snapshot before retrying.');
   const actual=this.isContentEditable?this.innerText:this.value;
   return actual.replace(/\r\n/g,'\n')===expected.replace(/\r\n/g,'\n');
  },[input.text]);
  check(expiresAt,signal);if(!verified)throw Error('The page did not retain the requested text. The input was not verified; read a fresh snapshot before retrying.');
  return {route:'trusted',dispatched:true,valueVerified:true};
 }finally{for(const id of new Set([objectId,documentId].filter(Boolean)))await send('Runtime.releaseObject',{objectId:id}).catch(()=>{});}
 });
}
