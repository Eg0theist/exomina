import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachLoginPopups, browserWebUrl } from '../desktop/browser-logins.mjs';

test('login popups preserve their session and opener without enabling native privileges',()=>{
  const wc=new EventEmitter();wc.setWindowOpenHandler=fn=>wc.open=fn;
  const session={},owner={};const popups=attachLoginPopups(wc,{window:owner,browserSession:session});
  assert.deepEqual(wc.open({url:'https://login.example.test'}),{action:'deny'});popups.show(true);
  const options=wc.open({url:'https://login.example.test'});
  assert.equal(options.action,'allow');assert.equal(options.overrideBrowserWindowOptions.parent,owner);
  assert.equal(options.overrideBrowserWindowOptions.webPreferences.session,session);
  assert.equal(options.overrideBrowserWindowOptions.webPreferences.nodeIntegration,false);
  assert.equal(options.overrideBrowserWindowOptions.webPreferences.sandbox,true);
  assert.equal(options.overrideBrowserWindowOptions.webPreferences.contextIsolation,true);
  const child=new EventEmitter();child.webContents=new EventEmitter();child.webContents.setWindowOpenHandler=fn=>child.webContents.open=fn;
  child.setMenu=()=>{};child.isDestroyed=()=>!!child.destroyed;child.show=()=>child.visible=true;child.hide=()=>child.visible=false;
  const childContents=child.webContents;Object.defineProperty(child,'webContents',{get(){if(child.destroyed)throw Error('Object has been destroyed');return childContents;}});
  child.destroy=()=>{child.destroyed=true;child.emit('closed');};
  wc.emit('did-create-window',child);child.emit('ready-to-show');assert.equal(child.visible,true);assert.equal(popups.owns(child.webContents),true);
  popups.show(false);assert.equal(child.visible,false);popups.show(true);assert.equal(child.visible,true);popups.close();assert.equal(wc.listenerCount('did-create-window'),0);
});

test('website and popup navigation reject executable, file and credential-bearing URLs',()=>{
  for(const url of ['javascript:alert(1)','file:///C:/private.txt','https://user:password@example.test'])assert.throws(()=>browserWebUrl(url),/Only/);
  assert.equal(browserWebUrl('about:blank',{blank:true}),'about:blank');
  const wc=new EventEmitter();wc.setWindowOpenHandler=fn=>wc.open=fn;const popups=attachLoginPopups(wc,{window:{},browserSession:{}});popups.show(true);
  assert.equal(wc.open({url:'file:///C:/private.txt'}).action,'deny');let prevented=false;wc.emit('will-redirect',{preventDefault:()=>prevented=true},'javascript:alert(1)');assert.equal(prevented,true);popups.close();
});
