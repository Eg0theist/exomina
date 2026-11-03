/** Update status reads touch several files. Keep one read active and retain the latest invalidation. */
export function createUpdateStatusRefresh({read,apply,onError=()=>{},visible=()=>true,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),delay=150}) {
  let closed=false,dirty=false,reportError=false,timer=null,pending=null;
  const drain=()=>{
    if(closed)return Promise.resolve();
    if(timer!==null){cancel(timer);timer=null;}
    if(pending)return pending;
    pending=Promise.resolve().then(async()=>{
      while(!closed&&dirty&&(visible()||reportError)){
        dirty=false;const explicit=reportError;reportError=false;
        try{const value=await read();if(!closed)apply(value);}
        catch(error){if(!closed&&explicit)onError(error);}
      }
    }).finally(()=>{pending=null;if(!closed&&dirty&&(visible()||reportError))return drain();});
    return pending;
  };
  return {
    request({immediate=false,reportError:explicit=false}={}){
      if(closed)return Promise.resolve();
      dirty=true;reportError ||= explicit;
      if(!visible()&&!reportError)return pending||Promise.resolve();
      if(pending)return pending;
      if(immediate)return drain();
      if(timer===null)timer=schedule(()=>{timer=null;void drain();},delay);
      return Promise.resolve();
    },
    dispose(){closed=true;dirty=false;reportError=false;if(timer!==null)cancel(timer);timer=null;},
  };
}
