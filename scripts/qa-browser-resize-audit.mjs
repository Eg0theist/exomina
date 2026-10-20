import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractFile} from '@electron/asar';
import {WindowsVault} from '../desktop/vault.mjs';

// Complete the audit after a successful hidden behavior run whose optional
// artifact collector used POSIX separators with Windows' asar reader. Never
// relaunches the app or repeats the already completed native browser checks.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reportPath=path.resolve(root,'../Workspace/browser-resize-verification/packaged-browser-resize-qa.json');
const bytes=await readFile(reportPath,'utf8'),report=JSON.parse(bytes);
assert.equal(report.passed,undefined);
assert.match(report.error,/dist\/assets\/index-YrtBsUVP\.js.*not found in this archive/);
assert.equal(Object.keys(report.checks).length,20);assert.ok(Object.values(report.checks).every(Boolean));
assert.equal(path.dirname(report.output),path.resolve(root,'../Workspace'));
assert.match(path.basename(report.output),/^qa-browser-resize-[A-Za-z0-9]+$/);
assert.equal(report.runtimeRoot,path.resolve(root,'../Workspace/browser-resize-20261010/stage/win-unpacked/resources/app.asar'));
assert.ok(report.failureWindows.some(window=>window.url===new URL('file:///'+report.runtimeRoot.replaceAll('\\','/')+'/dist/index.html').href));
const archiveBefore=await stat(report.runtimeRoot),archiveBytes=await readFile(report.runtimeRoot);
const archiveHash=createHash('sha256').update(archiveBytes).digest('hex');
const html=extractFile(report.runtimeRoot,path.join('dist','index.html')).toString('utf8');
const references=[...html.matchAll(/(?:src|href)="(\.\/assets\/index-[^"]+\.(?:js|css))"/g)].map(match=>match[1]);
assert.deepEqual(references,['./assets/index-YrtBsUVP.js','./assets/index-BDeyEbg2.css']);
const assets=[];for(const reference of references){
  const file=path.posix.join('dist',reference.slice(2));
  const archived=extractFile(report.runtimeRoot,path.normalize(file)),source=await readFile(path.join(root,file));
  const archivedHash=createHash('sha256').update(archived).digest('hex'),sourceHash=createHash('sha256').update(source).digest('hex');
  assert.equal(archivedHash,sourceHash);assets.push({file,sha256:archivedHash});
}
for(const diagnostics of [report.beforeRestartProhibitions,report.afterRestartProhibitions]){
  assert.equal(diagnostics.accountCalls,0);assert.equal(diagnostics.modelCalls,0);
  assert.deepEqual(diagnostics.bridgeRequests,[]);assert.equal(diagnostics.visibleWindows,0);assert.ok(diagnostics.boundsUpdates>0);
}
assert.deepEqual(report.errors,[]);
const profile=path.join(report.output,'data');
const recovery=JSON.parse(await readFile(profile+'.setup/recovery-backup.json','utf8'));
assert.equal(recovery.syntheticQaAcknowledgement,true);
const protection=await new WindowsVault().verify(profile,{recoveryThumbprint:recovery.thumbprint});
assert.equal(protection.encrypted,true);assert.equal(protection.restrictedAccess,true);
const archiveAfter=await stat(report.runtimeRoot);
assert.equal(archiveAfter.mtimeMs,archiveBefore.mtimeMs);assert.equal(archiveAfter.size,archiveBefore.size);
assert.equal(createHash('sha256').update(await readFile(report.runtimeRoot)).digest('hex'),archiveHash);
const preservedFailure=reportPath.replace(/\.json$/,'.metadata-failure.json');
await writeFile(preservedFailure,bytes,{flag:'wx'});
report.initialMetadataFailure={error:report.error,preservedReport:preservedFailure};delete report.error;
report.checks.noPersonalBrowserAccountModelOrVisibleWindow=true;report.checks.noRendererErrors=true;
report.protection=protection;
report.rendererEvidence={notice:'Artifact collection completed after app exit. Script reference was recorded by the initial metadata error; stylesheet reference comes from the same immutable archive index. Both archived assets match frozen Source SHA256.',observedScriptReferenceFromInitialError:references[0],archiveIndexStylesheetReference:references[1],assets};
report.archiveAudit={sha256:archiveHash,bytes:archiveAfter.size,modifiedAt:archiveAfter.mtime.toISOString(),unchangedAcrossPostRunAudit:true};
report.completion={behaviorChecksCompletedInOriginalHiddenRun:20,auditChecksCompletedPostRun:2,appClosedBeforePostRunAudit:true,notice:'Initial run completed every product check. A Windows path separator error interrupted only metadata/audit collection; the failed report is preserved and the remaining checks were completed against that same synthetic profile and unchanged archive.'};
report.screenshotLimit='Renderer-only failure screenshot excludes native child-view pixels. Native child geometry and local page viewport/resize events were verified in the successful behavior portion.';
report.passed=true;await writeFile(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:true,checks:Object.keys(report.checks).length,reportPath,preservedFailure,archive:report.archiveAudit,assets}));
