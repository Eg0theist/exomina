// Idempotent artifact acquisition only. Never retries extraction or execution.
const transientStatus=new Set([408,429,500,502,503,504]);
const transportCodes=new Set(['ECONNRESET','ECONNREFUSED','EAI_AGAIN','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
function transport(error){for(let current=error,depth=0;current&&depth<5;current=current.cause,depth++)if(transportCodes.has(current.code)||['TimeoutError','AbortError'].includes(current.name))return true;return false;}
export async function fetchRuntimeBytes(url,{label='Official runtime',maximumBytes=512*1024*1024,timeoutMs=60000,fetchImpl=fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),log=message=>console.warn(message)}={}){
 const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('Runtime artifacts require an HTTPS URL without credentials.');
 if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>512*1024*1024)throw Error('Use a bounded runtime archive size.');
 const asset=parsed.origin+parsed.pathname;
 for(let attempt=1;attempt<=3;attempt++){
  try{
   const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok){const error=Error(`HTTP ${response.status}`);error.status=response.status;error.transientDownload=transientStatus.has(response.status);await Promise.resolve(response.body?.cancel?.()).catch(()=>{});throw error;}
   if(!response.body)throw Error('Runtime download has no response body.');
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>maximumBytes)throw Error('Official runtime archive exceeds the download limit.');chunks.push(Buffer.from(chunk));}
   return Buffer.concat(chunks,size);
  }catch(error){
   const retryable=error.transientDownload===true||(!Number.isInteger(error.status)&&transport(error));
   log(`${label} download attempt ${attempt}/3 failed for ${asset}: ${error.message}${retryable&&attempt<3?'; retrying acquisition only.':'; stopping.'}`);
   if(!retryable||attempt===3){const failure=Error(`${label} download failed after ${attempt} attempt${attempt===1?'':'s'} for ${asset}: ${error.message}`,{cause:error});failure.attempts=attempt;failure.status=error.status;failure.code=error.code||error.cause?.code;failure.asset=asset;throw failure;}
   await wait(attempt===1?500:1500);
  }
 }
}
