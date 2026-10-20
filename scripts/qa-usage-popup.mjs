// Screenshot of the sidebar usage popup in the real renderer with synthetic usage data.
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=await mkdtemp(path.resolve('../Workspace/qa-usage-popup-'));
const server=await createServer({root,server:{port:5199,strictPort:false},logLevel:'error'});await server.listen();
const env={...process.env,EXOMINA_DESIGN_QA_URL:`http://localhost:${server.config.server.port}/preview.html`,EXOMINA_DESIGN_QA_DIR:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
let app;
try{
  app=await electron.launch({args:[path.join(root,'scripts/qa-design-main.cjs')],env,timeout:30000});const page=await app.firstWindow();
  await page.getByRole('button',{name:'Exomina home',exact:true}).waitFor();await page.setViewportSize({width:1500,height:1000});
  await page.locator('.usage-summary').click();await page.locator('.usage-details').waitFor();await page.waitForTimeout(600);
  const box=await page.locator('.usage-details').boundingBox();
  await page.screenshot({path:path.join(output,'popup.png'),clip:{x:0,y:Math.max(0,box.y-10),width:Math.min(1500,box.x+box.width+40),height:Math.min(1000-Math.max(0,box.y-10),box.height+120)}});
  console.log(JSON.stringify({output,box,scroll:await page.locator('.usage-details').evaluate(el=>[el.scrollHeight,el.clientHeight])}));
}finally{await app?.close();await server.close();}
