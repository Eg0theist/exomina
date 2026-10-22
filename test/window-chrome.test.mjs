import test from 'node:test';
import assert from 'node:assert/strict';
import { windowChromeOptions, applyWindowChromeTheme, windowChromeCommand, windowHudMode, TITLEBAR_HEIGHT } from '../desktop/window-chrome.mjs';
import { normalizeAppearance, validateAppearance } from '../desktop/themes.mjs';

test('borderless chrome uses native Windows controls and classic style remains selectable',()=>{
  assert.equal(normalizeAppearance().borderless,true);
  assert.equal(validateAppearance({borderless:false},{}).borderless,false);
  assert.throws(()=>validateAppearance({borderless:'yes'},{}),/borderless/);
  const options=windowChromeOptions({borderless:true,ground:'#101010',ink:'#eeeeee',platform:'win32'});
  assert.equal(options.titleBarStyle,'hidden');assert.equal(options.titleBarOverlay.height,TITLEBAR_HEIGHT);
  assert.deepEqual(windowChromeOptions({borderless:false,platform:'win32'}),{});
});

test('theme changes recolour the native caption buttons without changing window style',()=>{
  const calls=[],win={isDestroyed:()=>false,setTitleBarOverlay:value=>calls.push(value)};
  applyWindowChromeTheme(win,{borderless:true,ground:'#eeeeee',ink:'#101010',platform:'win32'});
  applyWindowChromeTheme(win,{borderless:false,ground:'#000000',ink:'#ffffff',platform:'win32'});
  assert.deepEqual(calls,[{color:'#eeeeee',symbolColor:'#101010',height:40}]);
});

test('window actions toggle maximize, minimize and close through the normal window lifecycle',()=>{
  const calls=[];let maximized=false;
  const win={isDestroyed:()=>false,isMaximized:()=>maximized,maximize:()=>{maximized=true;calls.push('maximize');},unmaximize:()=>{maximized=false;calls.push('restore');},minimize:()=>calls.push('minimize'),close:()=>calls.push('close')};
  for(const action of ['maximize','maximize','minimize','close'])windowChromeCommand(win,action);
  assert.deepEqual(calls,['maximize','restore','minimize','close']);assert.throws(()=>windowChromeCommand(win,'execute'),/Unknown/);
});

test('Hide HUD clears the native caption strip and peeks only the buttons',()=>{
  const calls=[],win={isDestroyed:()=>false,setTitleBarOverlay:value=>calls.push(value)};
  for(const hud of ['hidden','peek',null])applyWindowChromeTheme(win,{borderless:true,ground:'#101010',ink:'#eeeeee',hud,platform:'win32'});
  assert.deepEqual(calls.map(c=>[c.color,c.symbolColor]),[['#00000000','#00000000'],['#00000000','#eeeeee'],['#101010','#eeeeee']]);
  assert.equal(windowHudMode('peek'),'peek');assert.equal(windowHudMode('anything'),null);
});
