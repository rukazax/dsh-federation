// dsh_hub — хаб федерации, v0 (срез P0/P2): спаривание узлов, hello, приём index, выдача списков.
// Стоит отдельным процессом на время разработки; в DSH монтируется как плагин позже.
// Запуск: node src/hub.mjs --port 18990 --code ABCD --db ~/.dsh/federation.sqlite --vault /srv/apps/dsh/obsidian/vault
// Обзор базы: --overview-svg out.svg | --overview-json out.json (пишет и выходит, без сервера)
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

function sendText(res, status, type, body) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length });
  res.end(buf);
}

function json(res, status, body) {
  sendText(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
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

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU').replace(/\u00A0/g, ' ');

// Векторный обзор базы: тот же расчёт, что и JSON, но собранный как SVG для панели дашборда,
// GitHub и телеграма — картинка масштабируется без потерь и весит единицы килобайт.
export function overviewSvg(ov, { width = 960, rowStep = 45 } = {}) {
  const font = "ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif";
  const mono = 'ui-monospace,SFMono-Regular,Menlo,monospace';
  const head = (w, h, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Обзор базы Obsidian">\n` +
    `  <defs>\n    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#121a2e"/></linearGradient>\n` +
    `    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7aa2ff"/><stop offset=".6" stop-color="#9d7bff"/><stop offset="1" stop-color="#4de2c5"/></linearGradient>\n` +
    `  </defs>\n  <rect width="${w}" height="${h}" rx="18" fill="url(#bg)"/>\n  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="17" fill="none" stroke="#2b3a5c" stroke-width="2"/>\n` +
    body + '</svg>\n';

  const title = `<text x="40" y="56" font-family="${font}" font-size="26" font-weight="700" fill="#eaf0ff">Обзор базы Obsidian</text>\n`;
  const sub = (line) => `<text x="40" y="84" font-family="${mono}" font-size="13" fill="#8ea0c8">${esc(line)}</text>\n`;

  if (!ov || !ov.available) {
    const w = width;
    const body =
      title +
      sub('база недоступна · vault-missing') +
      `<text x="40" y="150" font-family="${font}" font-size="34" font-weight="700" fill="#ffb4a2">${esc('нет доступа к vault')}</text>\n` +
      `<text x="40" y="186" font-family="${mono}" font-size="14" fill="#a9b8dc">${esc(ov && ov.vault ? ov.vault : 'путь не задан')}</text>\n` +
      `<text x="40" y="222" font-family="${font}" font-size="14" fill="#8ea0c8">Панель честно сообщает об этом вместо пустого экрана и HTTP 500.</text>\n`;
    return head(w, 260, body);
  }

  const label = (name) => (name === '(root)' ? 'в корне vault' : name);
  const rows = Object.entries(ov.notes.bySection || {})
    .sort((a, b) => Math.max(b[1], 0) - Math.max(a[1], 0))
    .slice(0, 8);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const barMax = width - 190 - 120;
  const height = Math.max(430, 222 + rows.length * rowStep + 60);
  const a = ov.analysis;

  let body = title + sub(`GET /api/federation/memory/overview?format=svg · ${ov.vault} · ${ov.checked_at}`);
  body +=
    `<text x="40" y="150" font-family="${font}" font-size="44" font-weight="700" fill="#4de2c5">${esc(fmt(ov.notes.total))}</text>\n` +
    `<text x="40" y="176" font-family="${font}" font-size="15" fill="#a9b8dc">заметок .md в базе</text>\n` +
    `<text x="300" y="150" font-family="${font}" font-size="30" font-weight="700" fill="#eaf0ff">${esc(fmt(rows.length))}</text>\n` +
    `<text x="300" y="176" font-family="${font}" font-size="15" fill="#a9b8dc">разделов</text>\n` +
    `<text x="600" y="150" font-family="${font}" font-size="30" font-weight="700" fill="#eaf0ff">${esc(a ? fmt(a.chars) : '—')}</text>\n` +
    `<text x="600" y="176" font-family="${font}" font-size="15" fill="#a9b8dc">знаков в последнем обзоре</text>\n` +
    `<line x1="40" y1="198" x2="${width - 40}" y2="198" stroke="#2b3a5c" stroke-width="2"/>\n`;

  rows.forEach(([name, count], i) => {
    const y = 222 + i * rowStep;
    const w = Math.max(8, Math.round((count / max) * barMax));
    body +=
      `<text x="40" y="${y + 16}" font-family="${font}" font-size="15" fill="#dfe7ff">${esc(label(name))}</text>\n` +
      `<rect x="190" y="${y}" width="${w}" height="22" rx="6" fill="url(#bar)"/>\n` +
      `<text x="${width - 158}" y="${y + 16}" font-family="${mono}" font-size="15" fill="#9fb2d8">${esc(fmt(count))}</text>\n`;
  });

  const foot = a
    ? `последний обзор: ${a.name} · ${fmt(a.chars)} знаков · ${a.updated_at}`
    : 'обзора ещё нет: Аналитика/ пуста, кнопка «Обновить обзор» его создаст';
  body += `<text x="40" y="${height - 26}" font-family="${mono}" font-size="12" fill="#8ea0c8">${esc(foot)}</text>\n`;
  return head(width, height, body);
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
      const ov = vaultOverview(dir);
      if ((url.searchParams.get('format') || '').toLowerCase() === 'svg') {
        // ponytail: SVG собирается на каждый запрос, без кэша — база 9,6k заметок считается за ~10 мс;
        // кэш по mtime добавим, если панель начнёт дёргать маршрут чаще раза в секунду.
        return [200, overviewSvg(ov), 'image/svg+xml; charset=utf-8'];
      }
      return [200, { ok: true, ...ov }];
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
      if (out[2]) sendText(res, out[0], out[2], out[1]);
      else json(res, out[0], out[1]);
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
  const svgOut = arg('overview-svg', '');
  const jsonOut = arg('overview-json', '');
  if (svgOut || jsonOut) {
    const ov = vaultOverview(vaultPath);
    if (svgOut) {
      writeFileSync(svgOut, overviewSvg(ov));
      console.log(`svg ${svgOut} notes=${ov.notes.total} sections=${Object.keys(ov.notes.bySection).length}`);
    }
    if (jsonOut) {
      writeFileSync(jsonOut, JSON.stringify({ ok: true, ...ov }, null, 2));
      console.log(`json ${jsonOut} available=${ov.available}`);
    }
    process.exit(0);
  }
  const hub = createHub({ dbPath, pairCode: code, hubToken, vaultPath });
  hub.server.listen(port, '127.0.0.1', () => {
    console.log(`dsh_hub listening http://127.0.0.1:${port} db=${dbPath} pair=${code ? 'on' : 'OFF'}`);
  });
}
