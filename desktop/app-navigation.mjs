import {randomUUID} from 'node:crypto';
import {APP_DESTINATIONS} from './app-control-contract.mjs';
export class AppNavigation{
  constructor({getNavigation,isLive,send,onConfirmed=()=>{},timeoutMs=5000}){Object.assign(this,{getNavigation,isLive,send,onConfirmed,timeoutMs});this.pending=new Map();}
  request({destination,expected},conversationId){
    const ui=this.getNavigation();
    if(!APP_DESTINATIONS.includes(destination))throw Error('Unknown app destination.');
    if(!this.isLive(conversationId)||!ui||ui.private||ui.conversationId!==conversationId||['page','settingsSection','conversationId'].some(key=>ui[key]!==expected?.[key]))throw Error('Desktop navigation changed. Preview the destination again.');
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const finish=(error,result)=>{clearTimeout(timer);this.pending.delete(requestId);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>finish(Error('The desktop did not acknowledge navigation. The destination is unverified.')),this.timeoutMs);
      this.pending.set(requestId,{conversationId,destination,finish});
      try{this.send({type:'app.control.navigate',requestId,conversationId,destination,expected});}catch(error){finish(error);}
    });
  }
  acknowledge(input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['requestId','conversationId','confirmed','page','settingsSection','reason'].includes(key)))throw Error('Invalid navigation acknowledgment.');
    const request=this.pending.get(input.requestId);
    if(!request||request.conversationId!==input.conversationId)throw Error('This navigation request is no longer pending.');
    const [page,section]=request.destination.split(':'),correct=input.confirmed===true&&input.page===page&&(!section||input.settingsSection===section);
    if(!this.isLive(request.conversationId))request.finish(Error('The originating app-control task has stopped.'));
    else if(!correct)request.finish(Error('Desktop navigation was not confirmed'+(typeof input.reason==='string'?': '+input.reason.slice(0,200):'.')));
    else {try{this.onConfirmed({conversationId:request.conversationId,page:input.page,settingsSection:input.settingsSection});request.finish(null,{confirmed:true,destination:request.destination});}catch(error){request.finish(error);}}
    return {accepted:true};
  }
}
