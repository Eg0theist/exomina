// Install the already downloaded, verified model into the model cache only.
// No account files, app settings, chat records or credentials are opened.
import {readFile,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {downloadNliModel,NLI_MODELS,installedNliModel} from '../desktop/decision-nli.mjs';
const marker=path.resolve(process.argv[2]),source=path.resolve(process.argv[3]);
if(path.basename(marker)!=='exomina.paths.json')throw Error('Use the installed application location marker.');
const config=JSON.parse(await readFile(marker,'utf8'));
const home=path.resolve(path.dirname(marker),config.home),data=await realpath(path.join(home,'Private','data'));
if(data.toLowerCase()!==path.join(home,'Private','data').toLowerCase())throw Error('The model cache parent follows an unexpected link.');
const root=path.join(data,'decision-models'),model=NLI_MODELS.multilingual;
const installed=await downloadNliModel({root,id:model.id,fetchImpl:async url=>{
  const file=model.files.find(file=>url===`https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`);
  if(!file)throw Error('Unexpected model asset.');
  return {ok:true,status:200,body:createReadStream(path.join(source,...file.name.split('/')))};
}});
if((await installedNliModel(root))?.id!==model.id)throw Error('Installed model was not detected.');
console.log(JSON.stringify({root,model:installed.id,sizeMb:installed.sizeMb,files:installed.files.length,verified:true},null,2));
