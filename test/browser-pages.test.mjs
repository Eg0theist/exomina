import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatBrowser } from '../desktop/browser-pages.mjs';

const fixture=()=>{
  const events=[],saved=new Map(),made=[];
  const browser=new ChatBrowser({emit:event=>events.push(event),getSaved:id=>saved.get(id),saveState:async(id,state)=>saved.set(id,state),createPage:(id,emit)=>{
    const page={visible:false,url:'',title:'',history:[],formValue:'',closed:false,
      state(){return {url:this.url,title:this.title};},show(value){this.visible=value;},setBounds(bounds){this.bounds=bounds;},
      async navigate(url){this.url=url;this.history.push(url);emit({type:'browser.state',...this.state()});return this.state();},
      async call(name,input){await this.navigate(input.url);emit({type:'browser.reveal'});return {url:this.url};},stop(){this.stopped=true;},cancel(id){this.cancelled=id;},close(){this.closed=true;},definitions:[]};
    made.push(page);return page;
  }});return {browser,events,saved,made};
};
test('switching chats keeps each live page, form data and navigation history',async()=>{
  const {browser}=fixture();browser.show(true,'a');await browser.navigate('https://example.test/a');const a=browser.page();a.formValue='Unsubmitted draft';
  browser.show(true,'b');await browser.navigate('https://example.test/b');const b=browser.page();
  assert.equal(a.visible,false);assert.equal(b.visible,true);assert.equal(browser.state().url,'https://example.test/b');
  browser.select('a');assert.equal(a.visible,true);assert.equal(b.visible,false);assert.equal(a.formValue,'Unsubmitted draft');assert.deepEqual(a.history,['https://example.test/a']);
  assert.equal(browser.state().conversationId,'a');assert.equal(browser.state('b').url,'https://example.test/b');
});
test('background tools and cancellation target their own chat without switching the visible page',async()=>{
  const {browser,events}=fixture();browser.show(true,'a');await browser.navigate('https://example.test/a');
  await browser.call('browser_open',{url:'https://example.test/background'},'b');
  assert.equal(browser.selectedId,'a');assert.equal(browser.page('a').visible,true);assert.equal(browser.page('b').visible,false);
  assert.equal(browser.state().url,'https://example.test/a');assert.ok(events.some(event=>event.type==='browser.reveal'&&event.conversationId==='b'));
  browser.cancel('b');assert.equal(browser.page('b').cancelled,'b');assert.equal(browser.page('a').cancelled,undefined);
});
test('saved URLs restore lazily and deleting a chat closes only its page',async()=>{
  const {browser,saved,made}=fixture();saved.set('a',{url:'https://example.test/saved'});browser.select('a');assert.equal(made.length,0);
  const a=browser.page('a');await a.restore;assert.equal(a.url,'https://example.test/saved');
  browser.show(true,'b');const b=browser.page('b');browser.remove('a');assert.equal(a.closed,true);assert.equal(b.closed,false);assert.equal(browser.selectedId,'b');
  browser.close();assert.equal(b.closed,true);assert.equal(browser.pages.size,0);
});

test('disabled tools do not create or restore a page and switching to a closed pane stays lazy',async()=>{
  const {browser,saved,made}=fixture();browser.show(true,'a');await browser.navigate('https://example.test/a');
  saved.set('b',{url:'https://example.test/b'});browser.show(false,'b');assert.equal(made.length,1);assert.equal(browser.page('a').visible,false);
  browser.isEnabled=()=>false;await assert.rejects(browser.call('browser_snapshot',{},'b'),/tools are off/);assert.equal(made.length,1);
});
