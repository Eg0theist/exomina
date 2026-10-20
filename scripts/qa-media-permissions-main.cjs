// Synthetic Chromium microphone device only, in an isolated hidden QA window.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('mute-audio');
app.setPath('userData',path.join(process.env.EXOMINA_MEDIA_QA_DIR,'profile'));
app.whenReady().then(async()=>{
  const {audioPermission}=await import('../desktop/realtime-voice.mjs');
  const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  global.qaMedia={armed:false,visible:true,calls:[]};
  const decide=(webContents,permission,details,request)=>{const granted=audioPermission({webContents,mainContents:window.webContents,permission,details,request,visible:global.qaMedia.visible,armed:global.qaMedia.armed});global.qaMedia.calls.push({permission,request,isMainFrame:details?.isMainFrame,mediaTypes:details?.mediaTypes,mediaType:details?.mediaType,granted});return granted;};
  window.webContents.session.setPermissionCheckHandler((webContents,permission,_origin,details)=>decide(webContents,permission,details,false));
  window.webContents.session.setPermissionRequestHandler((webContents,permission,callback,details)=>callback(decide(webContents,permission,details,true)));
  await window.loadFile(path.join(process.env.EXOMINA_MEDIA_QA_DIR,'page.html'));
});
