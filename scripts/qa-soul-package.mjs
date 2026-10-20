import path from 'node:path';
process.env.EXOMINA_QA_RUNTIME_ROOT=path.resolve('release/win-unpacked/resources/app.asar');
await import('./qa-soul.mjs');
