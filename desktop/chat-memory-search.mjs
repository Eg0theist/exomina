import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';

// A derived, rebuildable keyword index over the immutable chat originals. It lives in its own
// database, so nothing here can alter or delay the source log. Writes happen only on a worker
// thread; the main thread runs short read-only queries.
const INDEX_VERSION = '2';
const SCHEMA = `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(body, tool, chat_id UNINDEXED, id UNINDEXED, role UNINDEXED, kind UNINDEXED, created_at UNINDEXED, tokenize='trigram');
  CREATE TABLE IF NOT EXISTS search_marks(chat_id TEXT PRIMARY KEY, next_id INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS search_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

export const searchFile = dataDir => path.join(path.resolve(dataDir), 'chat-memory', 'search.sqlite');
export const treeFile = dataDir => path.join(path.resolve(dataDir), 'chat-memory', 'tree.sqlite');

// Streamed tool output used to be stored once per growing snapshot: "<call>:output:<hash>:part:<n>".
const snapshot = key => { const match = /^(.*):output:([0-9a-f]+):part:\d+$/.exec(key); return match ? { call: match[1], hash: match[2] } : null; };

/** Indexes originals of one chat that are newer than its mark. Returns the number of documents added. */
export function indexChat(tree, search, chatId, { batch = 250 } = {}) {
  const last = tree.prepare('SELECT MAX(id) AS id FROM tree_originals WHERE chat_id=?').get(chatId)?.id;
  const from = search.prepare('SELECT next_id FROM search_marks WHERE chat_id=?').get(chatId)?.next_id ?? 0;
  if (last == null) { removeChat(search, chatId); return 0; }
  let start = from;
  if (start > last + 1) { removeChat(search, chatId); start = 0; }
  if (start > last) return 0;
  // The final snapshot of each call is the one that counts; earlier ones are superseded.
  const finalHash = new Map();
  for (const row of tree.prepare("SELECT event_key AS key FROM tree_originals WHERE chat_id=? AND id>=? AND kind='echo' AND event_key LIKE '%:output:%' ORDER BY id").iterate(chatId, start)) {
    const parsed = snapshot(row.key); if (parsed) finalHash.set(parsed.call, parsed.hash);
  }
  // A newer snapshot can arrive after a previous incremental pass. Retire its earlier indexed copies too.
  const erase = search.prepare('DELETE FROM search_docs WHERE chat_id=? AND id=?');
  const lineage = tree.prepare("SELECT id,event_key AS key FROM tree_originals WHERE chat_id=? AND kind='echo' AND event_key LIKE ? ESCAPE '!'");
  for(const [call, hash] of finalHash){
    const pattern=(call+':output:').replace(/[!%_]/g, character=>'!'+character)+'%';
    for(const row of lineage.iterate(chatId,pattern))if(snapshot(row.key)?.hash!==hash)erase.run(chatId,row.id);
  }
  const read = tree.prepare('SELECT id, role, kind, created_at AS createdAt, event_key AS key, text FROM tree_originals WHERE chat_id=? AND id>=? AND id<? ORDER BY id');
  const insert = search.prepare('INSERT INTO search_docs(body, tool, chat_id, id, role, kind, created_at) VALUES(?,?,?,?,?,?,?)');
  const mark = search.prepare('INSERT INTO search_marks(chat_id, next_id) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET next_id=excluded.next_id');
  let added = 0;
  for (let id = start; id <= last; id += batch) {
    const end = Math.min(id + batch, last + 1);
    search.exec('BEGIN IMMEDIATE');
    try {
      for (const row of read.all(chatId, id, end)) {
        const parsed = row.kind === 'echo' ? snapshot(row.key) : null;
        if (parsed && finalHash.get(parsed.call) !== parsed.hash) continue;
        if (!row.text || !row.text.trim()) continue;
        const isTool = row.kind === 'echo' || row.kind === 'tool';
        const text = row.text;
        insert.run(isTool ? '' : text, isTool ? text : '', chatId, row.id, row.role, row.kind, row.createdAt || '');
        added++;
      }
      mark.run(chatId, end);
      search.exec('COMMIT');
    } catch (error) { search.exec('ROLLBACK'); throw error; }
  }
  return added;
}

export function removeChat(search, chatId) {
  search.exec('BEGIN IMMEDIATE');
  try { search.prepare('DELETE FROM search_docs WHERE chat_id=?').run(chatId); search.prepare('DELETE FROM search_marks WHERE chat_id=?').run(chatId); search.exec('COMMIT'); }
  catch (error) { search.exec('ROLLBACK'); throw error; }
}

/** Runs one request against freshly opened databases; shared by the worker and by tests. */
export function runIndexRequest(dataDir, request) {
  const search = new DatabaseSync(searchFile(dataDir));
  search.exec(SCHEMA);
  try {
    const rebuild=search.prepare('SELECT value FROM search_meta WHERE key=?').get('index-version')?.value!==INDEX_VERSION;
    if(rebuild){
      search.exec('BEGIN IMMEDIATE');
      try{search.exec('DELETE FROM search_docs; DELETE FROM search_marks;');search.prepare('INSERT OR REPLACE INTO search_meta VALUES(?,?)').run('index-version',INDEX_VERSION);search.exec('COMMIT');}
      catch(error){search.exec('ROLLBACK');throw error;}
    }
    if (request.type === 'remove') { removeChat(search, request.chatId); return { added: 0 }; }
    const tree = new DatabaseSync(treeFile(dataDir), { readOnly: true });
    try {
      tree.exec('PRAGMA busy_timeout=5000');
      const chats = request.type === 'backfill' || rebuild ? tree.prepare('SELECT chat_id AS id FROM tree_chats').all().map(row => row.id) : [request.chatId];
      let added = 0;
      for (const chatId of chats) added += indexChat(tree, search, chatId);
      if (request.type === 'backfill') {
        // Chats deleted while the index was not looking.
        const known = new Set(chats);
        for (const row of search.prepare('SELECT chat_id AS id FROM search_marks').all()) if (!known.has(row.id)) removeChat(search, row.id);
      }
      return { added };
    } finally { tree.close(); }
  } finally { search.close(); }
}

const MAX_TOKENS = 12;
/** Turns free text into literal trigram phrases; tokens shorter than three characters cannot match. */
export function searchTokens(text) {
  const tokens = String(text || '').split(/\s+/u).map(token => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')).filter(token => [...token].length >= 3);
  return [...new Set(tokens.map(token => token.toLowerCase()))].slice(0, MAX_TOKENS);
}
const phrase = token => '"' + token.replaceAll('"', '""') + '"';

function excerpt(text, tokens, width = 360) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const token of tokens) { const found = lower.indexOf(token); if (found >= 0 && (at < 0 || found < at)) at = found; }
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  return (start ? '…' : '') + text.slice(start, start + width) + (start + width < text.length ? '…' : '');
}

export class ChatMemorySearch {
  #db = null; #worker = null; #queue = Promise.resolve(); #timers = new Map(); #idle = null;
  constructor(dataDir, { workerUrl = new URL('./chat-memory-search-worker.mjs', import.meta.url), createWorker = null, delay = 3000 } = {}) {
    Object.assign(this, { dataDir, workerUrl, createWorker, delay, closed: false, lastError: null, pending: 0 });
  }
  async init() {
    if (this.#db) return this;
    await mkdir(path.dirname(searchFile(this.dataDir)), { recursive: true, mode: 0o700 });
    const writer = new DatabaseSync(searchFile(this.dataDir)); writer.exec(SCHEMA); writer.close();
    this.#db = new DatabaseSync(searchFile(this.dataDir), { readOnly: true });
    this.#db.exec('PRAGMA busy_timeout=2000');
    return this;
  }
  #spawn() {
    if (this.#worker) return this.#worker;
    const file = fileURLToPath(this.workerUrl).replace(/app\.asar(?=[\\/])/u, 'app.asar.unpacked');
    const worker = this.createWorker ? this.createWorker(this.dataDir) : new Worker(file, { workerData: { dataDir: this.dataDir } });
    worker.unref?.();
    this.#worker = worker;
    return worker;
  }
  #request(request) {
    this.pending++;
    const run = () => this.closed ? undefined : new Promise((resolve, reject) => {
      const worker = this.#spawn();
      const finish = (fn, value) => { worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); clearTimeout(this.#idle); this.#idle = setTimeout(() => this.#release(), 30000); this.#idle.unref?.(); fn(value); };
      const onMessage = message => message.error ? finish(reject, Error(message.error)) : finish(resolve, message);
      const onError = error => { this.#worker = null; finish(reject, error); };
      const onExit = () => { this.#worker = null; finish(reject, Error('The search indexer stopped.')); };
      worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
      worker.postMessage(request);
    });
    const next = this.#queue.then(run);
    this.#queue = next.then(() => { this.lastError = null; }, error => { this.lastError = String(error.message || error).slice(0, 300); }).finally(() => { this.pending--; });
    return next;
  }
  #release() { const worker = this.#worker; this.#worker = null; worker?.terminate?.(); }
  /** Debounced catch-up for a chat that just received records. */
  touch(chatId) {
    if (this.closed || this.#timers.has(chatId)) return;
    const timer = setTimeout(() => { this.#timers.delete(chatId); this.sync(chatId).catch(() => {}); }, this.delay);
    timer.unref?.(); this.#timers.set(chatId, timer);
  }
  sync(chatId) { return this.#request({ type: 'sync', chatId }); }
  backfill() { return this.#request({ type: 'backfill' }); }
  remove(chatId) { clearTimeout(this.#timers.get(chatId)); this.#timers.delete(chatId); return this.#request({ type: 'remove', chatId }).catch(() => {}); }
  async flush(chatId) { clearTimeout(this.#timers.get(chatId)); this.#timers.delete(chatId); await this.sync(chatId).catch(() => {}); }
  status() {
    const counts = this.#db ? this.#db.prepare('SELECT COUNT(*) AS documents FROM search_docs').get() : { documents: 0 };
    return { documents: counts.documents, pending: this.pending, error: this.lastError };
  }
  /** Ranked keyword search. Conversation text outranks tool output; every hit names its original for conversation_zoom. */
  find(query, { chatIds = null, limit = 10, offset = 0 } = {}) {
    const tokens = searchTokens(query);
    if (!tokens.length) return { tokens, mode: 'none', results: [] };
    const scope = chatIds ? ` AND chat_id IN (${chatIds.map(() => '?').join(',')})` : '';
    if (chatIds && !chatIds.length) return { tokens, mode: 'none', results: [] };
    const sql = match => this.#db.prepare(`SELECT chat_id AS chatId, id, role, kind, created_at AS createdAt, body, tool, bm25(search_docs, 1.0, 0.25) AS score FROM search_docs WHERE search_docs MATCH ?${scope} ORDER BY score LIMIT ? OFFSET ?`).all(match, ...(chatIds || []), limit, offset);
    let mode = 'all', rows = sql(tokens.map(phrase).join(' AND '));
    if (!rows.length && tokens.length > 1 && !offset) { mode = 'any'; rows = sql(tokens.map(phrase).join(' OR ')); }
    return { tokens, mode, results: rows.map(row => ({ chatId: row.chatId, id: row.id, role: row.role, kind: row.kind, createdAt: row.createdAt || null, source: row.body ? 'conversation' : 'tool', snippet: excerpt(row.body || row.tool, tokens) })) };
  }
  async close() {
    this.closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear(); clearTimeout(this.#idle);
    await this.#queue.catch(() => {});
    this.#release();
    this.#db?.close(); this.#db = null;
  }
}
