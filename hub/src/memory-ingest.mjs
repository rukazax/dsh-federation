// Ингест в общий RAG хаба: пишем в тот же ctxdb.sqlite, что и dsh-memory-hub,
// теми же id (sha256 от kind|text) и той же разреженной векторизацией.
// Второй RAG не заводится — это требование docs/FEDERATION.md §6.
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const DEFAULT_MODULE = '/srv/apps/dsh/dsh-home/profiles/web/node_modules/@local/dsh-memory-hub/index.js';
const DEFAULT_DB = '/srv/apps/dsh/memory/ctxdb.sqlite';

let cached = null;

export async function openMemoryIngest({ modulePath = process.env.DSH_MEMORY_HUB_MODULE || DEFAULT_MODULE, dbPath = process.env.DSH_MEMORY_DB || DEFAULT_DB } = {}) {
  if (cached && cached.dbPath === dbPath && cached.modulePath === modulePath) return cached.store;
  const mh = await import(modulePath);
  const test = mh.__test || {};
  const { MemoryStore, embed, VEC_VERSION } = test;
  if (!MemoryStore || !embed) throw new Error('dsh-memory-hub не отдал MemoryStore/embed — проверь путь модуля');
  const store = new MemoryStore(dbPath, () => {});
  // IDF читается из meta и разбирается JSON — на каждом чанке это дорого, поэтому кэш.
  let idfCache = null;
  let idfAt = 0;
  const idf = () => {
    const now = Date.now();
    if (idfCache && now - idfAt < 60_000) return idfCache;
    try {
      idfCache = store.readIdf();
    } catch {
      idfCache = { map: new Map(), docCount: 0 };
    }
    idfAt = now;
    return idfCache;
  };
  const api = {
    dbPath,
    modulePath,
    /** Один чанк → 'new' | 'dupe' | 'short'. */
    add({ kind = 'note', text, project = '', session = '', turn = 0, ts } = {}) {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (t.length < 12) return 'short';
      const id = sha256(`${kind}|${t.slice(0, 3000)}`);
      const exists = store.db.prepare('SELECT 1 FROM chunks WHERE id = ?').get(id);
      store.upsertChunk(id, kind, t, String(project || ''), String(session || ''), Number.isFinite(turn) ? turn : 0,
        Number.isFinite(ts) ? ts : Date.now(), [...embed(t, idf())], VEC_VERSION);
      return exists ? 'dupe' : 'new';
    },
    count() {
      return store.db.prepare('SELECT count(*) c FROM chunks').get().c;
    },
    close() {
      try {
        store.db.close();
      } catch {
        /* база общая с плагином: закрытие не обязательно */
      }
      cached = null;
    }
  };
  cached = { dbPath, modulePath, store: api };
  return api;
}
