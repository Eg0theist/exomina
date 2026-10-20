import {parentPort, workerData} from 'node:worker_threads';
import {runIndexRequest} from './chat-memory-search.mjs';

// Indexing runs here so the app's main thread never waits on SQLite.
parentPort.on('message', request => {
  try { parentPort.postMessage({ ok: true, ...runIndexRequest(workerData.dataDir, request) }); }
  catch (error) { parentPort.postMessage({ error: String(error.message || error) }); }
});
