/** A failed or pending audit can never authorize a runtime. A single startup
 * audit covers concurrent status, login, model discovery and chat requests.
 */
export function privateGate({verify,mode='efs',onStatus=()=>{}}){
  let pending;
  return ()=>{
    if(!pending){
      onStatus({checking:true,ready:false});
      pending=Promise.resolve().then(verify).then(result=>{
        const selected=typeof mode==='function'?mode():mode;
        if(result?.restrictedAccess!==true||(selected==='standard'?(result?.ready!==true||result?.mode!=='standard'):selected!=='efs'||result?.encrypted!==true))throw Error('Private storage protection could not be confirmed.');
        onStatus({checking:false,ready:true});return result;
      }).catch(error=>{onStatus({checking:false,ready:false,error:error.message});throw error;});
    }
    return pending;
  };
}
