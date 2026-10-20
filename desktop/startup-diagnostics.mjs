// Explicitly enabled diagnostics contain fixed phases and built-in error classes
// only. They never include paths, user data, exception messages or credentials.
const phases=new Set([
 'locations.begin','locations.ready','profile.begin','profile.ready','profile.blocked',
 'app.whenReady.wait','app.whenReady.ready','secretStorage.begin','secretStorage.available','secretStorage.unavailable','secretStorage.unchecked',
 'stores.begin','stores.ready','api.begin','api.ready','localModels.begin','localModels.ready',
 'window.begin','window.created','tools.begin','tools.ready','sync.begin','sync.ready',
 'window.load.begin','window.load.ready','startup.ready',
]);
const errorClasses=new Set(['Error','TypeError','RangeError','SyntaxError','ReferenceError','URIError','EvalError','AggregateError']);
export function startupDiagnostics({enabled=false,write=line=>process.stderr.write(line+'\n')}={}){
 let stage='locations.begin';
 const output=line=>{if(!enabled)return false;try{write(line);return true;}catch{return false;}};
 return {
  phase(label){if(!phases.has(label))return false;stage=label;return output('[exomina-startup] phase='+label);},
  failure(error){let name='Error';try{if(errorClasses.has(error?.name))name=error.name;}catch{}
   return output('[exomina-startup] failure phase='+stage+' errorClass='+name);},
 };
}
