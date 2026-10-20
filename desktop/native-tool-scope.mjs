/** The provider supplies this capability; model arguments cannot choose an owner. */
export function nativeScopeLive(scope){
  if(!scope)return true;
  if(typeof scope.isActive!=='function')return false;
  try{return scope.isActive()===true;}catch{return false;}
}
export function assertNativeScope(scope){if(!nativeScopeLive(scope))throw Error('The originating native agent or turn has ended. The host action was stopped.');}
