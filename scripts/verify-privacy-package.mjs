import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractFile} from '@electron/asar';
const root=process.cwd(),release=path.join(root,'release','win-unpacked'),asar=path.join(release,'resources','app.asar');
const expected=['desktop/privacy.mjs','desktop/main.mjs','desktop/providers.mjs','desktop/api-agent.mjs','desktop/store.mjs','desktop/chat-memory-service.mjs','desktop/conversation-tools.mjs','desktop/cloud-client.mjs','desktop/data-export.mjs'];
const report={passed:false,files:[],version:JSON.parse(extractFile(asar,'package.json')).version};
for(const file of expected){const source=await readFile(path.join(root,file)),packaged=await readFile(path.join(release,'resources','app.asar.unpacked',file));assert.deepEqual(packaged,source,'Packaged file must match verified source: '+file);report.files.push({file,sha256:createHash('sha256').update(packaged).digest('hex')});}
const html=extractFile(asar,'dist/index.html').toString('utf8'),js=html.match(/src="\.\/(assets\/[^\"]+\.js)"/),css=html.match(/href="\.\/(assets\/[^\"]+\.css)"/);assert.ok(js);assert.ok(css);
const renderer=extractFile(asar,path.join('dist',...js[1].split('/'))).toString('utf8'),styles=extractFile(asar,path.join('dist',...css[1].split('/'))).toString('utf8');
for(const text of ['Start temporary chat','End temporary chat','Privacy & training','conversations.discard','chat.temporary.closed','no chat history or memories'])assert.ok(renderer.includes(text),'Renderer contains '+text);
assert.ok(styles.includes('.temporary-chat-banner'));assert.equal(JSON.parse(await readFile(path.join(release,'exomina.build.json'),'utf8')).version,report.version);report.passed=true;
await writeFile(path.resolve('../Workspace/privacy-package-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
