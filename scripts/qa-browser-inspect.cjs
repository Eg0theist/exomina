// Real shared BrowserPage, synthetic localhost page and isolated browser profile.
const {app,BrowserWindow,session}=require('electron');
const path=require('node:path'),fs=require('node:fs'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const output=path.resolve(__dirname,'../../Workspace/qa-browser-inspect-'+Date.now());fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));app.setPath('sessionData',path.join(output,'profile'));
app.whenReady().then(async()=>{
  const report={scope:'Real BrowserPage and Chromium resource cache; isolated localhost fixture; no user accounts or remote traffic.',checks:{}};let browser,window;const requests=[];
  const server=http.createServer((request,response)=>{requests.push(request.url);if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end('window.fixtureMarker="synthetic-model";');}else{response.setHeader('Content-Type','text/html');response.end('<title>Inspection fixture</title><input type=password value="secret-fixture"><input type=hidden value="hidden-fixture"><textarea>draft-fixture</textarea><h1>Source fixture</h1><script src="/app.js"></script>');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port+'/';
  try{
    const {BrowserPage}=await import(pathToFileURL(path.resolve(__dirname,'../desktop/browser.mjs')).href);window=new BrowserWindow({show:false});let enabled=false,approved=false;
    browser=new BrowserPage({window,browserSession:session.fromPartition('qa-inspect'),emit:()=>{},getSettings:()=>({browserEnabled:enabled}),isActive:()=>true,approve:async()=>approved});await browser.navigate(url);
    const decode=result=>JSON.parse(result.content[0].text);
    try{await browser.call('browser_inspect',{operation:'html'},'fixture');throw Error('Disabled tools executed');}catch(error){if(!/off/.test(error.message))throw error;}enabled=true;
    try{await browser.call('browser_inspect',{operation:'html'},'fixture');throw Error('Declined tool executed');}catch(error){if(!/declined/.test(error.message))throw error;}approved=true;report.checks.permissionGates=true;
    const html=decode(await browser.call('browser_inspect',{operation:'html'},'fixture'));if(!html.text.includes('Source fixture')||/secret-fixture|hidden-fixture|draft-fixture/.test(html.text))throw Error('HTML sanitation failed');report.checks.sanitizedHtml=true;
    const resources=JSON.parse(decode(await browser.call('browser_inspect',{operation:'resources'},'fixture')).text);const script=resources.find(r=>r.url.endsWith('/app.js'));if(!script)throw Error('Loaded script was not indexed');
    const count=requests.length;const source=decode(await browser.call('browser_inspect',{operation:'resource',url:script.url},'fixture'));if(!source.text.includes('synthetic-model')||requests.length!==count)throw Error('Resource read did not use the loaded cache');report.checks.cachedResourceRead=true;
    try{await browser.call('browser_inspect',{operation:'resource',url:url+'private-api'},'fixture');throw Error('Arbitrary address was fetched');}catch(error){if(!/not loaded/.test(error.message))throw error;}if(requests.length!==count)throw Error('Inspector made an unexpected request');report.checks.noArbitraryFetch=true;
    const chunk=decode(await browser.call('browser_inspect',{operation:'resource',url:script.url,offset:5,limit:7},'fixture'));if(chunk.text!==source.text.slice(5,12)||chunk.nextOffset!==12)throw Error('Pagination failed');report.checks.pagination=true;report.passed=true;
  }catch(error){report.passed=false;report.error=error.stack;process.exitCode=1;}
  finally{browser?.close();window?.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output}));app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
