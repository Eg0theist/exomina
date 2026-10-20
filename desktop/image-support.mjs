import {randomUUID} from 'node:crypto';

export const imageInstructions = 'For image creation in a ChatGPT/Codex chat, use the native image_gen tool when available. In Grok chats, use the native Imagine tools (image_gen, image_edit, image_to_video, reference_to_video) when the current user requests an image or video; Grok checks account access and limits. Exomina displays successful returned images and MP4 videos in chat. Never claim media was created without a successful tool result. Other providers can use image_generate with the connected ChatGPT subscription after approval of the exact prompt. Use image_read with a chat image ID to inspect an existing image. Never silently switch providers, use an API fallback, or invent a media URL.\n';

/** Bridges provider image events into the private asset store. Only metadata is
 * sent to the renderer. Delegated image jobs receive the approved prompt only. */
export class ImageSupport {
  constructor({assets,getProviders,getRun,getWorkspace,isConnected,canReadAsset=()=>false,checkUsage=async()=>true,approve,publish,emit=()=>{}}){Object.assign(this,{assets,getProviders,getRun,getWorkspace,isConnected,canReadAsset,checkUsage,approve,publish,emit});this.routes=new Map();this.jobs=new Map();this.failures=new Map();this.counts=new Map();}
  get definitions(){return [{name:'image_generate',description:'Create an image through the connected ChatGPT subscription from a chat using another provider. Exomina asks the user to approve the exact prompt sent to OpenAI. Returns an image saved in the current chat. Requires a ChatGPT connection; never uses an API key. ChatGPT/Codex chats should use their native image_gen tool directly.',inputSchema:{type:'object',properties:{prompt:{type:'string',minLength:1,maxLength:20000}},required:['prompt'],additionalProperties:false}}, {name:'image_read',description:'View a generated image by its image ID from the current Exomina chat. With shared memory on, images in other Exomina chats are also accessible. Image IDs are listed by conversation_read. Returns image pixels to the selected provider.',inputSchema:{type:'object',properties:{id:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['id'],additionalProperties:false}}];}
  handle(event){
    const parent=this.routes.get(event.conversationId),id=parent||event.conversationId;
    if(event.type==='chat.image.generated'||event.type==='chat.media.generated'){
      if(!this.getRun(id))return true;
      const pending=this.jobs.get(id)||[];
      const job=Promise.resolve(pending.at(-1)).then(async()=>{const attachment={...await this.assets.put(event.dataBase64,{mimeType:event.mimeType}),kind:event.mimeType==='video/mp4'?'video':'image'};if(!this.getRun(id))return;await this.publish(id,attachment);if(attachment.kind==='image')this.counts.set(id,(this.counts.get(id)||0)+1);}).catch(()=>{this.failures.set(id,'The media was generated, but Exomina could not safely save it.');});
      pending.push(job);this.jobs.set(id,pending);return true;
    }
    // A delegated model's incidental text never replaces the current assistant's reply.
    if(parent){if(event.type==='chat.tool')this.emit({...event,conversationId:parent});return true;}
    return false;
  }
  async flush(id){
    while(this.jobs.get(id)?.length){const jobs=this.jobs.get(id);this.jobs.set(id,[]);await Promise.all(jobs);}
    this.jobs.delete(id);const failure=this.failures.get(id);this.failures.delete(id);if(failure)throw Error(failure);
  }
  async call(name,args,id){
    if(!this.getRun(id))throw Error('This chat is no longer running.');
    if(name==='image_read'){if(!this.canReadAsset(id,args?.id))throw Error('This image is not available to the current chat.');const asset=await this.assets.get(args.id);if(!asset)throw Error('This image has not arrived on this device yet. Sync and try again.');if(!asset.mimeType.startsWith('image/'))throw Error('image_read supports images only.');return {content:[{type:'image',data:asset.dataBase64,mimeType:asset.mimeType}]};}
    if(name!=='image_generate')throw Error('Unknown image tool.');
    if(typeof args?.prompt!=='string'||!args.prompt.trim()||args.prompt.length>20000)throw Error('Describe the image in 1–20,000 characters.');
    if(!this.isConnected())throw Error('Connect ChatGPT in Connections to generate images with its subscription.');
    if(!await this.checkUsage())throw Error('ChatGPT image generation needs verified available subscription usage. Refresh usage or try again after its reset.');
    if(!await this.approve({title:'Create this image with ChatGPT?',detail:'This image prompt will be sent to OpenAI using your ChatGPT subscription:\n\n'+args.prompt,conversationId:id}))throw Error('Image generation was declined.');
    if(!this.getRun(id))throw Error('This chat has stopped.');
    if(!await this.checkUsage())throw Error('ChatGPT no longer has verified available usage.');
    const child='image-'+randomUUID(),before=this.counts.get(id)||0;this.routes.set(child,id);
    try{
      await this.getProviders().run({provider:'codex',conversationId:child,toolDefinitions:[],workspace:this.getWorkspace(),prompt:'Create the image described below using your native image_gen tool. Only generate the requested image; do not run shell commands, inspect files, use other tools, or access memory. Return the generated image. If the image tool is unavailable, say so and stop.\n\nImage request:\n'+args.prompt.trim()});
      await this.flush(id);if((this.counts.get(id)||0)<=before)throw Error('ChatGPT did not return an image. The subscription or selected model may not expose image generation.');
      return {content:[{type:'text',text:'Image created with the ChatGPT subscription and saved in this chat. The user can view it inline or choose Save image.'}]};
    }finally{this.routes.delete(child);}
  }
  cancel(id){for(const [child,parent] of this.routes)if(parent===id)this.getProviders()?.cancel(child);}
  async finish(id){try{await this.flush(id)}finally{this.counts.delete(id);}}
}
