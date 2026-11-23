// dsh_hub — хаб федерации, v0 (срез P0/P2): спаривание узлов, hello, приём index, выдача списков.
// Стоит отдельным процессом на время разработки; в DSH монтируется как плагин позже.
// Запуск: node src/hub.mjs --port 18990 --code ABCD --db ~/.dsh/federation.sqlite --vault /srv/apps/dsh/obsidian/vault
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      TEXT,
  os           TEXT,
  host         TEXT,
  token_hash   TEXT NOT NULL UNIQUE,
  capabilities TEXT,
  models_seen  TEXT,
  created_at   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT NOT NULL,
  node       TEXT NOT NULL,
  title      TEXT,
  cwd        TEXT,
  status     TEXT,
  updated_at TEXT,
  turns      INTEGER,
  size       INTEGER,
  PRIMARY KEY (id, node)
);
CREATE INDEX IF NOT EXISTS sessions_by_node ON sessions(node);
`;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const iso = () => new Date().toISOString();

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readJson(req, limit = 4 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '';

const ANALYSIS_DIR = 'Аналитика';

function walkMd(dir, depth = 0, acc = []) {
  if (depth > 3) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMd(full, depth + 1, acc);
    else if (e.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

// Обзор базы Obsidian: заметки по разделам + последний обзор `memory_analyze` (Аналитика/analysis-*.md).
// Считается на месте, без LLM: панель открывается бесплатно, а новый обзор — отдельным действием.
export function vaultOverview(vaultPath, excerptChars = 1600) {
  const notes = { total: 0, bySection: {} };
  if (!vaultPath || !existsSync(vaultPath)) {
    return { available: false, reason: 'vault-missing', vault: vaultPath || null, notes, analysis: null };
  }
  const files = walkMd(vaultPath);
  const prefix = vaultPath.endsWith('/') ? vaultPath : vaultPath + '/';
  let best = null;
  for (const f of files) {
    const rel = f.slice(prefix.length);
    const section = rel.includes('/') ? rel.split('/')[0] : '(root)';
    notes.bySection[section] = (notes.bySection[section] || 0) + 1;
    if (rel.startsWith(ANALYSIS_DIR + '/')) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(f).mtimeMs;
      } catch {
        continue;
      }
      // один и тот же mtime у пары файлов — не редкость (созданы одним ходом): берём старший по имени,
      // потому что дата в имени analysis-YYYY-MM-DD и есть хронология обзоров.
      if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && rel > best.rel)) best = { path: f, rel, mtimeMs };
    }
  }
  notes.total = files.length;
  let analysis = null;
  if (best) {
    let md = '';
    try {
      md = readFileSync(best.path, 'utf8');
    } catch {
      md = '';
    }
    analysis = {
      name: best.rel.slice(ANALYSIS_DIR.length + 1),
      updated_at: new Date(best.mtimeMs).toISOString(),
      chars: md.length,
      excerpt: md.slice(0, excerptChars),
      md
    };
  }
  return { available: true, vault: vaultPath, notes, analysis, checked_at: iso() };
}

export function createHub({ dbPath = ':memory:', pairCode = '', hubToken = '', vaultPath = process.env.DSH_OBSIDIAN_VAULT || '' } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const nodeByToken = (req) => {
    const t = bearer(req);
    if (!t) return null;
    return db.prepare('SELECT * FROM nodes WHERE token_hash = ?').get(sha256(t)) || null;
  };

  const touch = (nodeId) => db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(iso(), nodeId);

  const routes = {
    'GET /healthz': () => ({ ok: true, proto: 1, nodes: db.prepare('SELECT count(*) c FROM nodes').get().c }),

    'POST /fed/v1/pair': async (req) => {
      const body = await readJson(req);
      if (!pairCode || body.code !== pairCode) return [401, { ok: false, error: 'bad-pair-code' }];
      const n = body.node || {};
      if (!n.name) return [400, { ok: false, error: 'node.name required' }];
      const token = randomBytes(24).toString('hex');
      const id = 'node_' + randomBytes(4).toString('hex');
      db.prepare(
        `INSERT INTO nodes (id, name, version, os, host, token_hash, capabilities, models_seen, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, '{}', '[]', ?, ?)`
      ).run(id, String(n.name), n.version || null, n.os || null, n.host || null, sha256(token), iso(), iso());
      return [200, { ok: true, nodeId: id, token }];
    },

    'POST /fed/v1/hello': async (req) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const body = await readJson(req);
      if (body.proto !== 1) return [400, { ok: false, error: 'unsupported-proto' }];
      db.prepare('UPDATE nodes SET capabilities = ?, models_seen = ?, last_seen = ? WHERE id = ?').run(
        JSON.stringify(body.capabilities || {}),
        JSON.stringify(body.models_seen || []),
        iso(),
        node.id
      );
      // allowlist моделей пока пуст: P3a. v0 только подтверждает контракт.
      return [200, { ok: true, nodeId: node.id, proto: 1, allowlist: [] }];
    },

    'POST /fed/v1/index': async (req) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const body = await readJson(req);
      const list = Array.isArray(body.sessions) ? body.sessions : [];
      const up = db.prepare(
        `INSERT INTO sessions (id, node, title, cwd, status, updated_at, turns, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, node) DO UPDATE SET
           title=excluded.title, cwd=excluded.cwd, status=excluded.status,
           updated_at=excluded.updated_at, turns=excluded.turns, size=excluded.size`
      );
      db.exec('BEGIN');
      try {
        for (const s of list) {
          if (!s || !s.id) continue;
          up.run(String(s.id), node.id, s.title ?? null, s.cwd ?? null, s.status ?? null, s.updated_at ?? null,
            Number.isFinite(s.turns) ? s.turns : null, Number.isFinite(s.size) ? s.size : null);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      touch(node.id);
      return [200, { ok: true, upserted: list.length }];
    },

    'GET /api/federation/nodes': (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const rows = db.prepare('SELECT id, name, version, os, host, capabilities, models_seen, created_at, last_seen FROM nodes ORDER BY last_seen DESC').all();
      return [200, { ok: true, nodes: rows.map((r) => ({ ...r, capabilities: JSON.parse(r.capabilities || '{}'), models_seen: JSON.parse(r.models_seen || '[]') })) }];
    },

    'GET /api/federation/memory/overview': (req, url) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const dir = url.searchParams.get('vault') || vaultPath;
      return [200, { ok: true, ...vaultOverview(dir) }];
    },

    'GET /api/federation/sessions': (req, url) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const node = url.searchParams.get('node');
      const rows = node
        ? db.prepare('SELECT * FROM sessions WHERE node = ? ORDER BY updated_at DESC').all(node)
        : db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
      return [200, { ok: true, sessions: rows }];
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return json(res, 404, { ok: false, error: 'not-found' });
    try {
      const out = await handler(req, url);
      json(res, out[0], out[1]);
    } catch (e) {
      json(res, e.status || 500, { ok: false, error: e.message });
    }
  });

  return { server, db, close: () => (db.close(), server.close()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const port = Number(arg('port', 18990));
  const dbPath = arg('db', new URL('../federation.sqlite', import.meta.url).pathname);
  const code = arg('code', '');
  const hubToken = arg('hub-token', '');
  const vaultPath = arg('vault', process.env.DSH_OBSIDIAN_VAULT || '');
  const hub = createHub({ dbPath, pairCode: code, hubToken, vaultPath });
  hub.server.listen(port, '127.0.0.1', () => {
    console.log(`dsh_hub listening http://127.0.0.1:${port} db=${dbPath} pair=${code ? 'on' : 'OFF'}`);
  });
}
