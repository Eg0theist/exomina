/** The setup button consents to installation. A failed first install must not
 * leave a connection eligible for later automatic background installation. */
export async function enableOptionalConnection({id,settings,save,available,install}){
 const previous=settings.optInProviders?.[id];
 settings.optInProviders={...settings.optInProviders,[id]:true};
 try{await save();if(!await available())await install();}
 catch(error){
  if(previous!==true&&settings.optInProviders?.[id]===true){
   const restored={...settings.optInProviders};
   if(previous===undefined)delete restored[id];else restored[id]=previous;
   settings.optInProviders=restored;await save();
  }
  throw error;
 }
}
