const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('studio',Object.freeze({
  invoke:(method,payload)=>ipcRenderer.invoke('studio:invoke',method,payload),
  onEvent:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('studio:event',listener);return()=>ipcRenderer.removeListener('studio:event',listener)}
}));
