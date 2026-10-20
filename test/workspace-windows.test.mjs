import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { WorkspaceWindows } from '../desktop/workspace-windows.mjs';

const windowFixture = (bounds = { x: 0, y: 0, width: 800, height: 700 }) => {
  const window = new EventEmitter(); window.webContents = new EventEmitter();
  window.webContents.setWindowOpenHandler = fn => { window.open = fn; };
  window.webContents.getBackgroundThrottling=()=>window.webContents.throttled??true;
  window.webContents.setBackgroundThrottling=value=>{window.webContents.throttled=value;};
  window.isDestroyed = () => !!window.destroyed; window.getBounds = () => ({ ...bounds }); window.setMenu = () => {};
  window.setBounds=value=>{bounds={...value};window.emit('resize');};
  window.isVisible=()=>true;window.isMinimized=()=>false;window.isFocused=()=>!!window.focused;
  window.destroy = () => { window.destroyed = true; window.emit('closed'); };
  window.close = () => { window.emit('close'); window.destroy(); };
  return window;
};
const fixture = () => {
  const window = windowFixture(), events = [], owners = [], links = [];
  let now = 0;
  const manager = new WorkspaceWindows({ window, indexUrl: 'file:///app/index.html', emit: value => events.push(value), setBrowserOwner: value => owners.push(value), openExternal: url => links.push(url), now: () => now, getDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] });
  const detach = (id = 'browser-1', panel = 'browser') => {
    const prepared = manager.prepare({ id, panel });
    const accepted = window.open({ url: prepared.url }); assert.equal(accepted.action, 'allow');
    const child = windowFixture(); window.webContents.emit('did-create-window', child, { url: prepared.url });
    return { child, prepared, accepted };
  };
  return { window, manager, events, owners, links, detach, advance: value => { now += value; } };
};

test('only registered panel URLs open, once, without child IPC privileges', () => {
  const { window, manager, detach, links } = fixture();
  assert.equal(window.open({ url: 'file:///app/index.html#workspace-panel=unknown' }).action, 'deny');
  assert.equal(window.open({ url: 'https://example.test/' }).action, 'deny'); assert.deepEqual(links, ['https://example.test/']);
  for (const input of [{ id: '../bad', panel: 'browser' }, { id: 'a', panel: 'settings' }]) assert.throws(() => manager.prepare(input), /valid workspace/);
  const { child, prepared, accepted } = detach();
  assert.equal(window.open({ url: prepared.url }).action, 'deny');
  assert.equal(path.isAbsolute(accepted.overrideBrowserWindowOptions.webPreferences.preload), true);
  assert.equal(path.basename(accepted.overrideBrowserWindowOptions.webPreferences.preload), 'workspace-preload.cjs');
  assert.equal(accepted.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(accepted.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(child.open({ url: prepared.url }).action, 'deny');
  assert.throws(() => manager.prepare({ id: 'browser-2', panel: 'browser' }), /already detached/);
  let prevented = false; child.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.test/'); assert.equal(prevented, true);
});

test('browser ownership restores before a detached window closes, and closure stays idempotent', () => {
  const { window, manager, detach, owners, events } = fixture(); const { child } = detach();
  assert.throws(() => manager.owner('missing'), /no longer open/);
  assert.throws(() => manager.owner(undefined), /Choose/);
  manager.owner('browser-1'); assert.equal(owners.at(-1), child); assert.equal(manager.list().browserOwnerId, 'browser-1');
  const before = owners.length; child.on('close', () => { assert.equal(owners.at(-1), window); }); child.close();
  assert.equal(owners.length, before + 1); assert.equal(manager.list().browserOwnerId, null); assert.equal(manager.list().windows.length, 0);
  assert.equal(events.at(-1).type, 'workspace.window.closed'); assert.equal(events.at(-1).id, 'browser-1');
  assert.deepEqual(manager.close('browser-1'), { closed: true });
  const { child: notes } = detach('notes-1', 'notes'); assert.throws(() => manager.owner('notes-1'), /no longer open/); manager.closeAll(); assert.equal(notes.isDestroyed(), true);
});

test('stale or unknown openings are refused and saved geometry returns onto a display', () => {
  const { manager, window, advance } = fixture();
  const prepared = manager.prepare({ id: 'notes-1', panel: 'notes', bounds: { x: 90000, y: -90000, width: 9999, height: 9999 } });
  const bounds = manager.entries.get('notes-1').bounds; assert.deepEqual(bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  advance(60001); assert.equal(window.open({ url: prepared.url }).action, 'deny');
  const unknown = windowFixture(); window.webContents.emit('did-create-window', unknown, { url: 'file:///app/index.html#workspace-panel=unknown' }); assert.equal(unknown.isDestroyed(), true);
  manager.prepare({ id: 'notes-2', panel: 'notes' }); assert.equal(manager.entries.has('notes-1'), false);
});

test('native movement publishes only panel geometry and rejects browser ownership by another panel', () => {
  const { detach, events, manager } = fixture(); const { child } = detach('terminal-1', 'terminal');
  child.emit('resize'); assert.deepEqual(events.at(-1), { type: 'workspace.window.bounds', id: 'terminal-1', bounds: child.getBounds() });
  assert.deepEqual(manager.list(), { windows: [{ id: 'terminal-1', panel: 'terminal', bounds: child.getBounds() }], browserOwnerId: null });
  assert.throws(() => manager.owner('terminal-1'), /browser panel/); manager.owner(null);
});

test('child crashes and parent reload close detached views and restore the live browser', () => {
  const { window, manager, detach, owners } = fixture(); let { child } = detach(); manager.owner('browser-1');
  child.focused=true;assert.equal(manager.attended(),true);
  child.webContents.emit('render-process-gone',{},{});assert.equal(owners.at(-1),window);assert.equal(child.isDestroyed(),true);assert.equal(manager.attended(),false);
  ({child}=detach());manager.owner('browser-1');window.webContents.emit('did-start-navigation',{},'file:///app/index.html',false,true);
  assert.equal(child.isDestroyed(),true);assert.equal(owners.at(-1),window);assert.equal(manager.list().windows.length,0);
  ({child}=detach('notes-1','notes'));child.webContents.emit('did-navigate-in-page',{},'file:///app/index.html#other',true);assert.equal(child.isDestroyed(),true);
});

test('reloading a detached document redocks it before replacing its portal DOM', () => {
  const { manager, detach, owners, window }=fixture();const { child }=detach();manager.owner('browser-1');
  child.webContents.emit('did-start-navigation',{},'file:///app/index.html#workspace-panel=browser-1',false,true);assert.equal(child.isDestroyed(),false);
  child.webContents.emit('dom-ready');child.webContents.emit('did-start-navigation',{},'file:///app/index.html#workspace-panel=browser-1',false,true);
  assert.equal(child.isDestroyed(),true);assert.equal(owners.at(-1),window);assert.equal(manager.list().windows.length,0);
});

test('detached views keep parent timers running and restore its original throttling after the last closes',()=>{
  for(const original of [true,false]){
    const {window,detach}=fixture();window.webContents.throttled=original;
    const first=detach(),second=detach('notes-1','notes');assert.equal(window.webContents.getBackgroundThrottling(),false);
    first.child.close();assert.equal(window.webContents.getBackgroundThrottling(),false);
    second.child.close();assert.equal(window.webContents.getBackgroundThrottling(),original);
  }
});

test('display changes recover open detached window bounds and unregister on parent closure',()=>{
  const window=windowFixture(),displaySource=new EventEmitter();let displays=[{workArea:{x:0,y:0,width:1920,height:1080}},{workArea:{x:1920,y:0,width:1920,height:1080}}];
  const manager=new WorkspaceWindows({window,indexUrl:'file:///app/index.html',getDisplays:()=>displays,displaySource});
  const prepared=manager.prepare({id:'notes-1',panel:'notes',bounds:{x:2200,y:100,width:800,height:700}});window.open({url:prepared.url});
  const child=windowFixture({x:2200,y:100,width:800,height:700});window.webContents.emit('did-create-window',child,{url:prepared.url});
  displays=[{workArea:{x:0,y:0,width:1280,height:720}}];displaySource.emit('display-removed',{},{});
  assert.deepEqual(child.getBounds(),{x:480,y:20,width:800,height:700});window.close();assert.equal(displaySource.listenerCount('display-removed'),0);
});

test('satellite closure tolerates a destroyed parent window or webContents during native shutdown',()=>{
  for(const teardown of ['window','contents','getter']){
    const {window,manager,detach,owners,events}=fixture(),{child}=detach();manager.owner('browser-1');const priorEvents=events.length,priorOwners=owners.length;
    if(teardown==='window')window.destroyed=true;
    else if(teardown==='contents')window.webContents.isDestroyed=()=>true;
    else Object.defineProperty(window,'webContents',{get(){throw Error('Object has been destroyed');}});
    assert.doesNotThrow(()=>child.close());assert.equal(manager.browserOwnerId,null);assert.equal(manager.list().windows.length,0);
    assert.equal(events.length,priorEvents);assert.equal(owners.length,priorOwners);
  }
});

test('app shutdown and parent reload preserve floating layout while ordinary closure still redocks',()=>{
  for(const mode of ['shutdown','reload','ordinary']){
    const {window,manager,detach,owners,events}=fixture();detach();detach('notes-1','notes');manager.owner('browser-1');const start=events.length;
    if(mode==='reload')window.webContents.emit('did-start-navigation',{},'file:///app/index.html',false,true);
    else manager.closeAll(mode==='shutdown'?{preserveLayout:true}:undefined);
    assert.equal(manager.list().windows.length,0);assert.equal(manager.browserOwnerId,null);assert.equal(owners.at(-1),window);
    assert.equal(window.webContents.getBackgroundThrottling(),true);
    const lifecycleEvents=events.slice(start).filter(event=>['workspace.window.bounds','workspace.window.closed'].includes(event.type));
    if(mode==='ordinary')assert.deepEqual(lifecycleEvents.map(event=>event.type),['workspace.window.bounds','workspace.window.closed','workspace.window.bounds','workspace.window.closed']);
    else assert.deepEqual(lifecycleEvents,[]);
  }
});
