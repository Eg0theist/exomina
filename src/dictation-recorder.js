/** One finite local recording. No network, persistence, overlapping windows or sends. */
export class DictationRecorder {
  constructor({mediaDevices=globalThis.navigator?.mediaDevices,AudioContextImpl=globalThis.AudioContext,onLimit=()=>{}}={}){Object.assign(this,{mediaDevices,AudioContextImpl,onLimit});this.chunks=[];this.samples=0;this.closed=false;this.fraction=0;this.sum=0;this.count=0;}
  async start(){
    if(!this.mediaDevices?.getUserMedia||!this.AudioContextImpl)throw Error('Microphone capture is unavailable.');
    const stream=await this.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(this.closed){stream.getTracks().forEach(track=>track.stop());throw Error('Recording was cancelled.');}
    this.stream=stream;
    try{this.context=new this.AudioContextImpl({sampleRate:16000});if(!Number.isFinite(this.context.sampleRate)||this.context.sampleRate<16000||this.context.sampleRate>192000)throw Error('This audio device cannot capture at the required 16 kHz rate.');await this.context.resume();if(this.closed)throw Error('Recording was cancelled.');
      this.source=this.context.createMediaStreamSource(stream);this.processor=this.context.createScriptProcessor(4096,1,1);this.mute=this.context.createGain();this.mute.gain.value=0;
      this.processor.onaudioprocess=event=>this.append(event.inputBuffer.getChannelData(0),this.context.sampleRate);
      this.source.connect(this.processor);this.processor.connect(this.mute);this.mute.connect(this.context.destination);
    }catch(error){this.cancel();throw error;}
  }
  append(input,sampleRate){
    if(this.closed||this.limited)return;
    if(!Number.isFinite(sampleRate)||sampleRate<16000||sampleRate>192000)throw Error('Unsupported microphone sample rate.');
    const out=[],ratio=sampleRate/16000;
    for(let i=0;i<input.length;i++){
      this.sum+=input[i];this.count++;this.fraction++;
      if(this.fraction>=ratio){this.fraction-=ratio;out.push(Math.max(-32768,Math.min(32767,Math.round(this.sum/this.count*32767))));this.sum=0;this.count=0;if(this.samples+out.length>=1_920_000)break;}
    }
    if(out.length){this.chunks.push(Int16Array.from(out));this.samples+=out.length;}
    if(this.samples>=1_920_000){this.limited=true;this.release();this.onLimit();}
  }
  release(){if(this.processor)this.processor.onaudioprocess=null;this.source?.disconnect();this.processor?.disconnect();this.mute?.disconnect();this.stream?.getTracks().forEach(track=>track.stop());this.context?.close().catch(()=>{});this.stream=null;}
  cancel(){this.closed=true;this.release();this.chunks=[];this.samples=0;}
  finish(){
    if(this.closed)throw Error('Recording was cancelled.');this.closed=true;this.release();if(this.samples<1600){this.chunks=[];throw Error('Record at least a short phrase before transcribing.');}
    const wav=new Uint8Array(44+this.samples*2),view=new DataView(wav.buffer),ascii=(at,text)=>{for(let i=0;i<text.length;i++)wav[at+i]=text.charCodeAt(i);};
    ascii(0,'RIFF');view.setUint32(4,wav.length-8,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,this.samples*2,true);
    let offset=44;for(const chunk of this.chunks)for(const value of chunk){view.setInt16(offset,value,true);offset+=2;}
    this.chunks=[];this.samples=0;let binary='';for(let i=0;i<wav.length;i+=0x8000)binary+=String.fromCharCode(...wav.subarray(i,i+0x8000));const encoded=btoa(binary);wav.fill(0);return encoded;
  }
}
