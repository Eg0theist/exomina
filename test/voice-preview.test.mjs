import test from 'node:test';
import assert from 'node:assert/strict';
import {VoicePreviewSession} from '../src/voice-preview-session.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture({play=[],clearClips={},load=null,settings={}}={}){
  const events=[],audios=[],timers=[],remoteCalls=[];
  const config={conversationId:'chat',page:'chat',settings};
  const session=new VoicePreviewSession({
    current:()=>config,update:event=>events.push(event),clips:{cove:'local-cove.wav',maple:'local-maple.wav'},clearClips,load,
    // A preview must not touch the live subscription or microphone APIs.
    invoke:(...args)=>{remoteCalls.push(args);throw Error('No preview RPC is permitted.');},
    getMedia:()=>{throw Error('No preview microphone is permitted.');},
    createAudio:()=>{
      const next=play.shift(),audio={src:'',playCalls:0,play(){this.playCalls++;return next?next():Promise.resolve();},pause(){this.paused=true;},removeAttribute(name){this.removedAttribute=name;},load(){this.loads=(this.loads||0)+1;},remove(){this.removed=true;}};
      audios.push(audio);return audio;
    },
    schedule:(fn,ms)=>{const timer={fn,ms,cancelled:false};timers.push(timer);return timer;},
    unschedule:timer=>{if(timer)timer.cancelled=true;}
  });
  return {session,events,audios,timers,remoteCalls,config};
}

test('preview starts the selected local recording immediately without RPC, capture or WebRTC',async()=>{
  const f=fixture();await f.session.start({previewVoice:'maple'});
  assert.equal(f.audios.length,1);assert.equal(f.audios[0].src,'local-maple.wav');assert.equal(f.audios[0].playCalls,1);
  assert.equal(f.session.mode,'preview');assert.equal(f.session.phase,'playing');assert.equal(f.events.at(-1).voiceId,'maple');
  assert.ok(f.events.some(event=>event.phase==='starting'));assert.match(f.events.at(-1).hint,/Microphone off/);assert.deepEqual(f.remoteCalls,[]);
  await f.session.stop();
});

test('the default local sample is Cove and finishing releases its player and timers',async()=>{
  const f=fixture();await f.session.start();const audio=f.audios[0];assert.equal(audio.src,'local-cove.wav');
  audio.onended();await tick();
  assert.equal(f.session.mode,'');assert.equal(f.session.audio,null);assert.equal(f.events.at(-1).phase,'idle');assert.equal(f.events.at(-1).hint,'Voice sample finished.');
  assert.equal(audio.paused,true);assert.equal(audio.src,'');assert.equal(audio.removedAttribute,'src');assert.equal(audio.loads,1);assert.equal(audio.removed,true);
  assert.equal(audio.onended,null);assert.equal(audio.onerror,null);assert.equal(audio.onplaying,null);assert.ok(f.timers.every(timer=>timer.cancelled));
});

test('Clear is the default preview while Original preserves the source and switching releases playback',async()=>{
  const f=fixture({clearClips:{cove:'local-cove-clear.wav',maple:'local-maple-clear.wav'}});
  await f.session.start({previewVoice:'cove'});const clear=f.audios[0];assert.equal(clear.src,'local-cove-clear.wav');
  f.config.settings={previewTone:'original'};await f.session.start({previewVoice:'cove'});assert.equal(clear.paused,true);assert.equal(clear.src,'');assert.equal(f.audios[1].src,'local-cove.wav');
  f.config.settings={previewTone:'clear'};await f.session.start({previewVoice:'maple'});assert.equal(f.audios[1].paused,true);assert.equal(f.audios[2].src,'local-maple-clear.wav');assert.deepEqual(f.remoteCalls,[]);await f.session.stop();
});

test('Clear falls back to the original when a matching derived recording is unavailable',async()=>{
  const f=fixture({clearClips:{cove:'local-cove-clear.wav'}});f.session.clips['claude:buttery']='local-buttery.mp3';
  await f.session.start({previewVoice:'claude:buttery'});assert.equal(f.audios[0].src,'local-buttery.mp3');await f.session.stop();
});

test('switching recordings stops and clears the previous source before playing the next voice',async()=>{
  const f=fixture();await f.session.start({previewVoice:'cove'});const first=f.audios[0];
  await f.session.start({previewVoice:'maple'});const second=f.audios[1];
  assert.equal(first.paused,true);assert.equal(first.src,'');assert.equal(first.onended,null);assert.equal(second.src,'local-maple.wav');assert.equal(f.session.audio,second);
  assert.equal(f.events.at(-1).voiceId,'maple');assert.equal(f.events.at(-1).phase,'playing');await f.session.stop();
});

test('concurrent starts only play the most recently selected voice',async()=>{
  const f=fixture();await Promise.all([f.session.start({previewVoice:'cove'}),f.session.start({previewVoice:'maple'})]);
  assert.equal(f.audios.length,1);assert.equal(f.audios[0].src,'local-maple.wav');assert.equal(f.session.voice,'maple');await f.session.stop();
});

test('a previous player resolving or failing late cannot change a newer preview',async()=>{
  for(const failure of [false,true]){
    const pending=deferred(),f=fixture({play:[()=>pending.promise]}),first=f.session.start({previewVoice:'cove'});await tick();
    const old=f.audios[0];await f.session.start({previewVoice:'maple'});const latest=f.audios[1],count=f.events.length;
    failure?pending.reject(Error('Old playback failed.')):pending.resolve();await first;
    assert.equal(old.paused,true);assert.equal(f.session.audio,latest);assert.equal(latest.paused,undefined);assert.equal(f.session.mode,'preview');assert.equal(f.session.phase,'playing');assert.equal(f.events.length,count);
    await f.session.stop();
  }
});

test('Stop while playback is pending prevents late playback from restarting the preview',async()=>{
  const pending=deferred(),f=fixture({play:[()=>pending.promise]}),started=f.session.start({previewVoice:'cove'});await tick();
  await f.session.stop();const count=f.events.length;pending.resolve();await started;
  assert.equal(f.session.mode,'');assert.equal(f.session.audio,null);assert.equal(f.events.length,count);assert.equal(f.audios[0].paused,true);assert.ok(f.timers.every(timer=>timer.cancelled));
});

test('unknown and inherited voice names cannot create a player',async()=>{
  for(const voice of ['unavailable','__proto__','constructor']){
    const f=fixture();await f.session.start({previewVoice:voice});
    assert.equal(f.session.mode,'');assert.equal(f.session.phase,'error');assert.match(f.events.at(-1).error,/No preview recording/);assert.equal(f.audios.length,0);assert.equal(f.timers.length,0);
  }
});

test('blocked audio playback exposes an error and releases the player',async()=>{
  const f=fixture({play:[()=>Promise.reject(Error('Autoplay blocked.'))]});await f.session.start({previewVoice:'cove'});
  assert.equal(f.session.mode,'');assert.equal(f.session.phase,'error');assert.match(f.events.at(-1).error,/playback was blocked/);assert.equal(f.audios[0].paused,true);assert.equal(f.session.audio,null);assert.ok(f.timers.every(timer=>timer.cancelled));
});

test('a recording error exposes an error and clears the source',async()=>{
  const f=fixture();await f.session.start({previewVoice:'cove'});f.audios[0].onerror();await tick();
  assert.equal(f.session.mode,'');assert.equal(f.session.phase,'error');assert.match(f.events.at(-1).error,/recording could not be played/);assert.equal(f.audios[0].src,'');assert.ok(f.timers.every(timer=>timer.cancelled));
});

test('a player that cannot start is stopped within the five-second preparation timeout',async()=>{
  const pending=deferred(),f=fixture({play:[()=>pending.promise]}),started=f.session.start({previewVoice:'cove'});await tick();
  const timer=f.timers.find(timer=>timer.ms===5000);assert.ok(timer);await timer.fn();
  assert.equal(f.session.phase,'error');assert.match(f.events.at(-1).error,/could not start/);assert.equal(f.session.audio,null);assert.equal(f.audios[0].paused,true);
  const count=f.events.length;pending.resolve();await started;assert.equal(f.events.length,count);assert.ok(f.timers.every(item=>item.cancelled));
});

test('a started recording has a bounded playback timeout instead of waiting indefinitely',async()=>{
  const f=fixture();await f.session.start({previewVoice:'cove'});
  assert.equal(f.timers.find(timer=>timer.ms===5000).cancelled,true);const timer=f.timers.find(item=>item.ms===30000&&!item.cancelled);assert.ok(timer);await timer.fn();
  assert.equal(f.session.mode,'');assert.equal(f.session.phase,'error');assert.match(f.events.at(-1).error,/did not finish/);assert.equal(f.audios[0].paused,true);assert.ok(f.timers.every(item=>item.cancelled));
});

test('navigation and global voice reset stop local previews while unrelated events are ignored',async()=>{
  for(const action of [session=>session.scopeChanged('other','chat'),session=>session.scopeChanged('chat','settings'),session=>session.receive({type:'voice.reset'})]){
    const f=fixture();await f.session.start({previewVoice:'cove'});
    f.session.scopeChanged('chat','chat');f.session.receive({type:'voice.realtime.event',sessionId:'unrelated'});assert.equal(f.session.mode,'preview');
    await action(f.session);assert.equal(f.session.mode,'');assert.equal(f.session.audio,null);assert.equal(f.audios[0].paused,true);assert.ok(f.timers.every(timer=>timer.cancelled));
  }
});

test('a recording the user copied from their own app is fetched on demand and played',async()=>{
  const asked=[];
  const f=fixture({load:async(voice,tone)=>{asked.push([voice,tone]);return 'blob:imported-'+voice+'-'+tone;}});
  await f.session.start({previewVoice:'sol'});
  assert.deepEqual(asked,[['sol','clear']]);assert.equal(f.audios[0].src,'blob:imported-sol-clear');assert.equal(f.session.phase,'playing');
  await f.session.stop();
  f.config.settings={previewTone:'original'};await f.session.start({previewVoice:'claude:airy'});
  assert.deepEqual(asked.at(-1),['claude:airy','original']);assert.equal(f.audios[1].src,'blob:imported-claude:airy-original');
  await f.session.stop();
});

test('built-in recordings never trigger a lookup',async()=>{
  let calls=0;const f=fixture({load:async()=>{calls++;return 'blob:other';}});
  await f.session.start({previewVoice:'maple'});assert.equal(calls,0);assert.equal(f.audios[0].src,'local-maple.wav');await f.session.stop();
});

test('a voice with no copied recording reports that cleanly and creates no player',async()=>{
  const f=fixture({load:async()=>''});
  await f.session.start({previewVoice:'ember'});
  assert.equal(f.audios.length,0);assert.equal(f.session.mode,'');assert.equal(f.events.at(-1).phase,'error');assert.match(f.events.at(-1).error,/No preview recording/);
});

test('a failed lookup points the user back to Settings instead of claiming playback was blocked',async()=>{
  const f=fixture({load:async()=>{throw Error('The saved voice sample was changed.');}});
  await f.session.start({previewVoice:'ember'});
  assert.equal(f.audios.length,0);assert.equal(f.session.mode,'');assert.match(f.events.at(-1).error,/Add the voice previews again in Settings/);
});

test('stopping while a recording is still loading never starts it',async()=>{
  let release;const f=fixture({load:()=>new Promise(resolve=>{release=resolve;})});
  const starting=f.session.start({previewVoice:'ember'});await tick();
  await f.session.stop();release('blob:late');await starting;
  assert.equal(f.audios.length,0);assert.equal(f.session.mode,'');assert.equal(f.events.at(-1).phase,'idle');
});
