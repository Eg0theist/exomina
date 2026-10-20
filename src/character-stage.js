/** Observable task and voice state takes precedence over optional prose cues. */
export function characterStage({needsInput=false,working=false,voice={},reply='',expressive=true,playful=false}={}){
 if(needsInput)return {state:'waiting',label:'Needs your input'};
 if(voice.active){if(voice.phase==='speaking')return {state:'speaking',label:'Speaking'};if(voice.phase==='listening')return {state:'listening',label:'Listening · microphone on'};return {state:'working',label:'Voice · '+(voice.phase||'connecting')};}
 if(working)return {state:'working',label:'Working'};
 if(playful)return {state:'wave',label:'Hello'};
 if(expressive){const text=String(reply).slice(0,2000);if(/^\s*\[(happy|excited|cheerful)\]/i.test(text))return {state:'wave',label:'Ready'};if(/^\s*\[(thoughtful|curious)\]/i.test(text))return {state:'curious',label:'Ready'};}
 return {state:'ready',label:'Ready'};
}
