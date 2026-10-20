// Isolated synthetic browser fixture; never loads a real account profile.
const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../Workspace/qa-browser-capture');
const profile = path.join(output, 'profile-' + process.pid);
require('node:fs').mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.whenReady().then(async () => {
  const report = { scope: 'Isolated localhost fixture; real page reads during pending resource loads, injected stalls/cancellation, and native capture; no account stores.', checks: {} };
  const server = http.createServer((req, res) => {
    if (req.url === '/pending-image' || req.url === '/never-ready') return;
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><title>Synthetic browser fixture</title><body style="background:#112233;color:white"><main><h1>Synthetic capture fixture</h1><input aria-label="Test field"><button onclick="this.textContent=\'Action confirmed\';document.querySelector(\'input\').style.display=\'none\'">Test action</button>'+(req.url==='/loading'?'<img src="/pending-image">':'')+'</main></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ width: 1000, height: 740, show: false });
  const { EmbeddedBrowser } = await import(pathToFileURL(path.resolve(__dirname, '../desktop/browser.mjs')).href);
  let allow=true, enabled=true;
  const events=[];
  const browser = new EmbeddedBrowser({ window: win, emit:event=>events.push(event), approve: async () => allow, getSettings: () => ({ browserEnabled: enabled }) });
  browser.select('synthetic-chat');
  const base='http://127.0.0.1:' + server.address().port;
  const stateOf=result=>JSON.parse(result.content.find(e=>e.type==='text').text);
  try {
    await browser.navigate('http://127.0.0.1:' + server.address().port + '/');
    const nativeCapture = browser.wc.capturePage.bind(browser.wc);
    browser.wc.capturePage = async () => { throw Error('UnknownVizError'); };
    const fallback = await browser.call('browser_snapshot', {}, 'synthetic-chat');
    const text = JSON.parse(fallback.content[0].text);
    assert.match(text.text, /Synthetic capture fixture/);
    assert.equal(text.screenshot.available, false);
    assert.equal(text.screenshot.reason, 'UnknownVizError');
    assert.ok(text.elements.some(e => e.text === 'Test action' && e.selector));
    assert.equal(fallback.content.some(e => e.type === 'image'), false);
    report.checks.captureFailurePreservesTextAndSelectors = true;
    allow=false;
    await assert.rejects(browser.call('browser_snapshot', {}, 'synthetic-chat'), /declined/);
    report.checks.approvalStillRequired = true;
    allow=true;enabled=false;
    await assert.rejects(browser.call('browser_snapshot', {}, 'synthetic-chat'), /off/);
    report.checks.disabledGateStillRequired = true;
    enabled=true;
    browser.wc.capturePage=nativeCapture;
    browser.show(true);
    const normal = await browser.call('browser_snapshot', {}, 'synthetic-chat');
    const png = normal.content.find(e => e.type === 'image');
    if (png) {
      const bytes=Buffer.from(png.data,'base64');
      assert.equal(bytes.subarray(1,4).toString(), 'PNG');
      await fs.writeFile(path.join(output,'native-capture.png'),bytes);
      report.nativeCapture={available:true,bytes:bytes.length};
    } else report.nativeCapture=JSON.parse(normal.content[0].text).screenshot;
    assert.match(JSON.parse(normal.content[0].text).text, /Synthetic capture fixture/);
    // Probe a viewport capture of this exact same synthetic WebContents, never another browser.
    try {
      browser.wc.debugger.attach('1.3');
      const captured=await Promise.race([
        browser.wc.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:false,captureBeyondViewport:false}),
        new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Viewport capture timed out')),1500))
      ]);
      const bytes=Buffer.from(captured.data,'base64');
      assert.equal(bytes.subarray(1,4).toString(),'PNG');
      await fs.writeFile(path.join(output,'viewport-capture.png'),bytes);
      report.viewportCaptureProbe={available:true,bytes:bytes.length};
    }catch(error){report.viewportCaptureProbe={available:false,reason:error.message}}
    finally{if(browser.wc.debugger.isAttached())browser.wc.debugger.detach()}

    browser.runtime.timeouts.capture=120;
    browser.wc.capturePage=()=>new Promise(()=>{});
    let began=Date.now();
    const stalledCapture=await browser.call('browser_snapshot',{},'synthetic-chat');
    assert.ok(Date.now()-began<1200);
    assert.match(stateOf(stalledCapture).text,/Synthetic capture fixture/);
    assert.match(stateOf(stalledCapture).screenshot.reason,/timed out/);
    assert.notEqual(stalledCapture.isError,true);
    report.checks.stalledCaptureReturnsText=true;

    browser.wc.capturePage=nativeCapture;
    browser.runtime.timeouts.capture=2500;
    began=Date.now();
    const loading=await browser.navigate(base+'/loading');
    assert.equal(loading.pageReady,true);
    assert.equal(browser.wc.isLoading(),true);
    const reading=await browser.call('browser_snapshot',{},'synthetic-chat');
    assert.ok(Date.now()-began<5500);
    assert.match(stateOf(reading).text,/Synthetic capture fixture/);
    assert.equal(stateOf(reading).pageRead.available,true);
    assert.equal(browser.wc.isLoading(),true,'The deliberately pending image must still be loading.');
    const field=stateOf(reading).elements.find(e=>e.tag==='INPUT');
    const button=stateOf(reading).elements.find(e=>e.tag==='BUTTON');
    await browser.call('browser_type',{selector:field.selector,text:'Live read — ä 中文'},'synthetic-chat');
    await browser.call('browser_click',{selector:button.selector},'synthetic-chat');
    const after=await browser.call('browser_snapshot',{},'synthetic-chat');
    assert.match(stateOf(after).text,/Action confirmed/);
    assert.equal(await browser.wc.mainFrame.executeJavaScript('document.querySelector("input").value'),'Live read — ä 中文');
    await assert.rejects(browser.call('browser_click',{selector:button.selector},'synthetic-chat'),/Element not found/);
    await assert.rejects(browser.call('browser_type',{selector:field.selector,text:'Stale text must not be applied'},'synthetic-chat'),/Element not found/);
    assert.equal(await browser.wc.mainFrame.executeJavaScript('document.querySelector("input").value'),'Live read — ä 中文');
    report.checks.pageReadAndActionsDuringBackgroundLoad=true;
    report.checks.staleSnapshotSelectorsRejected=true;
    report.checks.approvedToolsRevealSharedPane=events.some(e=>e.type==='browser.reveal');

    const frame=browser.wc.mainFrame;
    const nativeRead=frame.executeJavaScript;
    frame.executeJavaScript=()=>new Promise(()=>{});
    browser.wc.capturePage=()=>new Promise(()=>{});
    browser.runtime.timeouts.read=180;browser.runtime.timeouts.capture=120;
    began=Date.now();
    const stalledRead=await browser.call('browser_snapshot',{},'synthetic-chat');
    assert.ok(Date.now()-began<1200);
    assert.equal(stalledRead.isError,true);
    assert.equal(stateOf(stalledRead).pageRead.available,false);
    assert.equal(stateOf(stalledRead).screenshot.available,false);
    report.checks.stalledReadAndCaptureFinishWithExplicitError=true;

    const pending=browser.call('browser_snapshot',{},'synthetic-cancel');
    const canceled=assert.rejects(pending,/stopped/);
    await new Promise(resolve=>setTimeout(resolve,30));
    browser.cancel('synthetic-cancel');
    await canceled;
    assert.equal(browser.page('synthetic-cancel').operations.has('synthetic-cancel'),false);
    report.checks.stopCancelsPendingBrowserRead=true;
    frame.executeJavaScript=nativeRead;browser.wc.capturePage=nativeCapture;
    browser.runtime.timeouts.read=4000;browser.runtime.timeouts.capture=2500;

    browser.runtime.timeouts.navigation=400;
    began=Date.now();
    await assert.rejects(browser.navigate(base+'/never-ready'),/did not become ready/);
    assert.ok(Date.now()-began<1500);
    await browser.navigate(base+'/recovered');
    for(let i=0;i<3;i++)assert.match(stateOf(await browser.call('browser_snapshot',{},'synthetic-chat')).text,/Synthetic capture fixture/);
    report.checks.navigationDeadlineAndRecovery=true;
    report.checks.repeatedReadsAfterFailure=true;
    report.passed=true;
  } catch(error) { report.failure=error.stack;process.exitCode=1; }
  finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    browser.close();win.destroy();server.closeAllConnections();await new Promise(resolve => server.close(resolve));app.exit(process.exitCode||0);
  }
}).catch(error => { console.error(error); app.exit(1); });
