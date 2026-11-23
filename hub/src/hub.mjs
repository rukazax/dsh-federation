// dsh_hub — хаб федерации, v0 (срез P0/P2): спаривание узлов, hello, приём index, выдача списков.
// Стоит отдельным процессом на время разработки; в DSH монтируется как плагин позже.
// Запуск: node src/hub.mjs --port 18990 --code ABCD --db ~/.dsh/federation.sqlite --vault /srv/apps/dsh/obsidian/vault
// Обзор базы: --overview-svg out.svg | --overview-json out.json (пишет и выходит, без сервера)
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { openMemoryIngest } from './memory-ingest.mjs';
import { createLlmGateway } from './llm-gateway.mjs';
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
  snapshot_at TEXT,
  seq        INTEGER,
  PRIMARY KEY (id, node)
);
CREATE INDEX IF NOT EXISTS sessions_by_node ON sessions(node);

-- Очередь команд узлам. seq — курсор SSE, command_id — идемпотентность повтора.
CREATE TABLE IF NOT EXISTS commands (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE,
  node       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  state      TEXT NOT NULL DEFAULT 'queued',
  result     TEXT
);
CREATE INDEX IF NOT EXISTS commands_by_node ON commands(node, state);

-- Снапшот переписки: то, что видно в UI хаба. Узел присылает, хаб читает.
CREATE TABLE IF NOT EXISTS snapshots (
  session_id TEXT NOT NULL,
  node       TEXT NOT NULL,
  up_to_seq  INTEGER,
  messages   TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (session_id, node)
);

CREATE TABLE IF NOT EXISTS usage (
  request_id TEXT PRIMARY KEY,
  node       TEXT,
  provider   TEXT,
  model      TEXT,
  ts         TEXT,
  in_tokens  INTEGER,
  out_tokens INTEGER,
  cache_read INTEGER,
  cost_usd   TEXT,
  status     TEXT,
  ms         INTEGER
);

CREATE TABLE IF NOT EXISTS memory_ingest (
  node  TEXT NOT NULL,
  day   TEXT NOT NULL,
  chunks INTEGER NOT NULL DEFAULT 0,
  dupes INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node, day)
);

CREATE TABLE IF NOT EXISTS node_automation (
  node       TEXT PRIMARY KEY,
  applied_sha TEXT,
  dsh_version TEXT,
  state      TEXT,
  drift      TEXT,
  last_error TEXT,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  actor  TEXT,
  node   TEXT,
  action TEXT,
  session TEXT,
  result TEXT,
  detail TEXT
);

-- Телефон как устройство (ТЗ P2c): своя очередь команд, потому что у него нет SSE-узла.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  model        TEXT,
  android      TEXT,
  sdk          INTEGER,
  mode         TEXT NOT NULL DEFAULT 'sandbox',
  capabilities TEXT,
  policies     TEXT,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_commands (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE,
  device     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  state      TEXT NOT NULL DEFAULT 'queued',
  result     TEXT,
  error      TEXT,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS device_commands_by_device ON device_commands(device, state);

-- Токены шлюза моделей (P3a): узел ходит к хабу, а не к провайдеру со своим ключом.
CREATE TABLE IF NOT EXISTS llm_tokens (
  key_hash   TEXT PRIMARY KEY,
  target     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'node',
  created_at TEXT NOT NULL
);
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

// Дашборд хаба: один файл, без сборки и зависимостей. Токен спрашивается один раз и живёт в localStorage.
function dashboardHtml() {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh_hub · федерация</title>
<style>
 :root{--bg:#0b1220;--card:#121a2e;--line:#2b3a5c;--fg:#eaf0ff;--dim:#8ea0c8;--acc:#4de2c5}
 *{box-sizing:border-box} body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
 header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}
 header b{font-size:16px} header span{color:var(--dim);font:12px ui-monospace,monospace}
 input,button,textarea{font:inherit;background:#0e1730;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
 button{cursor:pointer} button:hover{border-color:var(--acc)}
 main{display:grid;grid-template-columns:240px 320px 1fr;gap:12px;padding:12px;height:calc(100vh - 60px)}
 section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;overflow:auto}
 h3{margin:2px 0 8px;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
 .row{padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
 .row:hover{background:#16203a} .row.sel{border-color:var(--acc);background:#16203a}
 .row small{display:block;color:var(--dim);font:11px ui-monospace,monospace}
 #msgs{display:flex;flex-direction:column;gap:8px;min-height:200px}
 .m{border:1px solid var(--line);border-radius:10px;padding:8px 10px;white-space:pre-wrap;word-break:break-word}
 .m.user{border-color:#3b5bdb} .m.assistant{background:#0f1a30} .m.tool{color:var(--dim);font:12px ui-monospace,monospace}
 .m b{display:block;font-size:11px;color:var(--dim);text-transform:uppercase;margin-bottom:3px}
 footer{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)} footer textarea{flex:1;min-height:42px;resize:vertical}
 .pill{border:1px solid var(--line);border-radius:999px;padding:2px 8px;font:11px ui-monospace,monospace;color:var(--dim)}
</style></head><body>
<header><b>dsh_hub</b><span id="state">токен хаба →</span>
 <input id="tok" placeholder="hub-token" style="width:230px">
 <button onclick="saveTok()">войти</button><button onclick="reloadAll()">обновить</button>
 <span class="pill" id="stats"></span></header>
<main>
 <section><h3>Узлы</h3><div id="nodes"></div></section>
 <section><h3>Сессии</h3><div id="sessions"></div></section>
 <section style="display:flex;flex-direction:column">
   <h3 id="title">Переписка</h3><div id="msgs"></div>
   <footer><textarea id="prompt" placeholder="промпт в сессию узла — исполнится там"></textarea>
   <button onclick="sendPrompt()">отправить</button><button onclick="cancelPrompt()">стоп</button></footer>
 </section>
</main>
<script>
const $=(id)=>document.getElementById(id); let TOK=localStorage.getItem('hubToken')||''; let SEL=null;
// ?token=… как у самого DSH Web: удобно открыть ссылку и не вводить токен руками
const qTok=new URLSearchParams(location.search).get('token'); if(qTok){TOK=qTok;localStorage.setItem('hubToken',qTok);}
$('tok').value=TOK;
const api=async(p,o={})=>{const r=await fetch(p,{...o,headers:{'content-type':'application/json',authorization:'Bearer '+TOK,...(o.headers||{})}});
 if(!r.ok) throw new Error(r.status+' '+await r.text()); return r.json();};
function saveTok(){TOK=$('tok').value.trim();localStorage.setItem('hubToken',TOK);reloadAll();}
async function reloadAll(){try{
 const st=await api('/api/federation/stats');
 $('stats').textContent=\`узлов \${st.nodes} · сессий \${st.sessions} · снапшотов \${st.snapshots}\`;
 const n=await api('/api/federation/nodes');
 $('nodes').innerHTML=n.nodes.map(x=>\`<div class="row" onclick="pickNode('\${x.id}')"><b>\${x.name}</b><small>\${x.id} · \${x.os||''} · \${x.last_seen}</small></div>\`).join('')||'<i>нет узлов</i>';
 $('state').textContent='на связи';
 await loadSessions();
}catch(e){$('state').textContent='ошибка: '+e.message}}
let NODE=null;
async function pickNode(id){NODE=id;await loadSessions()}
async function loadSessions(){const q=NODE?'?node='+encodeURIComponent(NODE):'';
 const s=await api('/api/federation/sessions'+q);
 $('sessions').innerHTML=s.sessions.map(x=>\`<div class="row" onclick='openSession(\${JSON.stringify(x.id)},\${JSON.stringify(x.node)})'><b>\${x.title||x.id}</b><small>\${x.node} · \${x.status||''} · \${x.updated_at||''}</small></div>\`).join('')||'<i>нет сессий</i>';}
async function openSession(id,node){SEL={id,node};
 const r=await api('/api/federation/session?id='+encodeURIComponent(id)+'&node='+encodeURIComponent(node));
 $('title').textContent=(r.session.title||id)+' · '+node;
 $('msgs').innerHTML=(r.messages||[]).map(m=>\`<div class="m \${m.role||''}"><b>\${m.role||''}</b>\${(m.text||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>\`).join('')||'<i>снапшота ещё нет — узел пришлёт после хода</i>';}
async function sendPrompt(){if(!SEL)return; const text=$('prompt').value.trim(); if(!text)return;
 await api('/api/federation/prompt',{method:'POST',body:JSON.stringify({node:SEL.node,sessionId:SEL.id,text})});
 $('prompt').value=''; $('state').textContent='промпт поставлен в очередь'; setTimeout(reloadAll,1500);}
async function cancelPrompt(){if(!SEL)return; await api('/api/federation/cancel',{method:'POST',body:JSON.stringify({node:SEL.node,sessionId:SEL.id})});$('state').textContent='стоп отправлен';}
if(TOK) reloadAll(); else $('state').textContent='нужен hub-token';
</script></body></html>`;
}

/**
 * Манифест автоматизации: что хаб раскатывает на узлы.
 *
 * Это профиль хаба, а не отдельный реестр (docs/FEDERATION.md §9): скиллы из $DSH_HOME/skills
 * и чек-скрипты. Патчи ядра сюда не входят — их применение требует root на узле, поэтому они
 * остаются ручным шагом; врать «применили» хуже, чем честно не привозить.
 */
export function buildAutomationManifest({ homeDir, skillsDir, checkDir } = {}) {
  const home = homeDir || process.env.DSH_HOME || '/srv/apps/dsh/dsh-home';
  const skills = skillsDir || join(home, 'skills');
  const checks = checkDir || '/srv/apps/dsh/workspaces/pc_admin/scripts';
  const files = [];
  const walk = (root, prefix, kind) => {
    if (!existsSync(root)) return;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          try {
            const buf = readFileSync(full);
            files.push({
              kind,
              path: prefix + '/' + full.slice(root.length + 1).split(sep).join('/'),
              sha256: sha256(buf),
              bytes: buf.length
            });
          } catch {
            /* нечитаемый файл в манифест не попадает */
          }
        }
      }
    }
  };
  walk(skills, 'skills', 'skill');
  for (const name of ['check-plugin-manager-enabled.mjs', 'check-bash-description.mjs', 'check-local-package-names.mjs']) {
    const full = join(checks, name);
    if (!existsSync(full)) continue;
    const buf = readFileSync(full);
    files.push({ kind: 'check', path: 'checks/' + name, sha256: sha256(buf), bytes: buf.length });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const sha = sha256(JSON.stringify(files.map((f) => [f.path, f.sha256])));
  return {
    sha,
    proto: 1,
    dsh_version: process.env.DSH_VERSION || null,
    created_at: iso(),
    counts: { skill: files.filter((f) => f.kind === 'skill').length, check: files.filter((f) => f.kind === 'check').length },
    files
  };
}

export function createHub({ dbPath = ':memory:', pairCode = '', hubToken = '', vaultPath = process.env.DSH_OBSIDIAN_VAULT || '', llmUpstream = process.env.DSH_LLM_UPSTREAM || undefined, llmAllow = null, credentialsPaths = [] } = {}) {  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // старые БД v0 не знают новых колонок: добираем, а не пересоздаём базу
  for (const col of ['snapshot_at TEXT', 'seq INTEGER']) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
    } catch {
      /* колонка уже есть */
    }
  }

  const nodeByToken = (req) => {
    const t = bearer(req);
    if (!t) return null;
    return db.prepare('SELECT * FROM nodes WHERE token_hash = ?').get(sha256(t)) || null;
  };

  const touch = (nodeId) => db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(iso(), nodeId);

  const logAudit = (actor, node, action, session, result, detail) =>
    db.prepare('INSERT INTO audit (ts, actor, node, action, session, result, detail) VALUES (?,?,?,?,?,?,?)')
      .run(iso(), actor ?? null, node ?? null, action, session ?? null, result ?? null,
        detail === undefined ? null : JSON.stringify(detail));

  // ── Телефон как устройство (ТЗ P2c): регистрация, очередь команд, ожидание ответа.
  // Агент не получает прав устройства: он просит, приложение проверяет режим и политику.
  const PHONE_KINDS = ['screenshot', 'ui_tree', 'tap', 'swipe', 'text', 'key', 'launch', 'shell', 'stop'];
  const deviceByToken = (req) => {
    const t = bearer(req);
    if (!t) return null;
    return db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(sha256(t)) || null;
  };
  const touchDevice = (id) => db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(iso(), id);
  /** Кто вправе просить телефон: сам хаб (viewer) или доверенный узел федерации. */
  const caller = (req) => {
    if (hubToken && bearer(req) === hubToken) return { actor: 'viewer', node: null };
    const n = nodeByToken(req);
    return n ? { actor: `node:${n.name}`, node: n.id } : null;
  };
  const waiting = new Map();
  const settle = (commandId, value) => {
    const list = waiting.get(commandId);
    if (!list) return;
    waiting.delete(commandId);
    for (const resolve of list) resolve(value);
  };
  const waitFor = (commandId, ms) =>
    new Promise((resolve) => {
      const done = setTimeout(() => {
        waiting.delete(commandId);
        resolve(null);
      }, ms);
      const settleOnce = (v) => {
        clearTimeout(done);
        resolve(v);
      };
      const list = waiting.get(commandId) || [];
      list.push(settleOnce);
      waiting.set(commandId, list);
    });
  const commandRow = (id) => db.prepare('SELECT * FROM device_commands WHERE command_id = ?').get(id);
  const commandView = (r) =>
    r && {
      commandId: r.command_id, device: r.device, kind: r.kind, state: r.state,
      created_at: r.created_at, done_at: r.done_at,
      result: r.result ? JSON.parse(r.result) : null, error: r.error || null
    };
  const expireDevice = () =>
    db.prepare(`UPDATE device_commands SET state = 'expired', done_at = ? WHERE state = 'queued' AND expires_at IS NOT NULL AND expires_at < ?`)
      .run(iso(), iso()).changes;

  // Шлюз моделей: единственные ворота наружу. Ключи провайдера остаются на хабе.
  const llm = createLlmGateway({ db, upstream: llmUpstream, allow: llmAllow, logAudit, credentialsPaths });

  // ── SSE: у каждого узла свой набор живых потоков. Команда уходит сразу, если узел на связи,
  // иначе ждёт в commands до TTL — узел заберёт по курсору при переподключении.
  const streams = new Map();
  const broadcast = (node, event) => {
    const set = streams.get(node);
    if (!set) return 0;
    let sent = 0;
    for (const res of set) {
      try {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        sent++;
      } catch {
        set.delete(res);
      }
    }
    return sent;
  };

  const enqueue = (node, kind, payload, ttlSec = 300) => {
    const commandId = randomBytes(6).toString('hex');
    const createdAt = iso();
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    const r = db.prepare(
      `INSERT INTO commands (command_id, node, kind, payload, created_at, expires_at, state)
       VALUES (?,?,?,?,?,?, 'queued')`
    ).run(commandId, node, kind, JSON.stringify(payload ?? {}), createdAt, expiresAt);
    const seq = Number(r.lastInsertRowid);
    broadcast(node, { seq, commandId, kind, payload: payload ?? {}, created_at: createdAt, expires_at: expiresAt });
    return { commandId, seq, expires_at: expiresAt };
  };

  const expireStale = () =>
    db.prepare(`UPDATE commands SET state = 'expired' WHERE state = 'queued' AND expires_at IS NOT NULL AND expires_at < ?`)
      .run(iso()).changes;

  // Снапшот устарел или его нет → просим узел. Гейт по времени, чтобы обновление страницы
  // не превращалось в поток команд.
  const snapshotAsked = new Map();
  const askSnapshot = (nodeId, sessionId, staleMs = 20_000) => {
    const key = `${nodeId}|${sessionId}`;
    const now = Date.now();
    const snap = db.prepare('SELECT at FROM snapshots WHERE session_id = ? AND node = ?').get(String(sessionId), nodeId);
    const fresh = snap && now - Date.parse(snap.at) < staleMs;
    if (fresh || now - (snapshotAsked.get(key) || 0) < 10_000) return null;
    snapshotAsked.set(key, now);
    return enqueue(nodeId, 'snapshot', { sessionId: String(sessionId) }, 120);
  };

  const saveSnapshot = (nodeId, sessionId, messages, upToSeq) => {
    db.prepare(
      `INSERT INTO snapshots (session_id, node, up_to_seq, messages, at) VALUES (?,?,?,?,?)
       ON CONFLICT(session_id, node) DO UPDATE SET
         up_to_seq = excluded.up_to_seq, messages = excluded.messages, at = excluded.at`
    ).run(String(sessionId), nodeId, Number.isFinite(upToSeq) ? upToSeq : null, JSON.stringify(messages || []), iso());
    db.prepare('UPDATE sessions SET snapshot_at = ? WHERE id = ? AND node = ?').run(iso(), String(sessionId), nodeId);
  };

  // Поток команд узлу. Курсор — seq последней полученной команды (Last-Event-ID или ?cursor=).
  const handleStream = (req, res, url) => {
    const node = nodeByToken(req);
    if (!node) return json(res, 401, { ok: false, error: 'unknown-node' });
    const cursor = Number(req.headers['last-event-id'] || url.searchParams.get('cursor') || 0);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    let set = streams.get(node.id);
    if (!set) {
      set = new Set();
      streams.set(node.id, set);
    }
    set.add(res);
    touch(node.id);
    expireStale();
    for (const r of db.prepare(
      `SELECT * FROM commands WHERE node = ? AND seq > ? AND state = 'queued' ORDER BY seq`
    ).all(node.id, cursor)) {
      res.write(`id: ${r.seq}\ndata: ${JSON.stringify({
        seq: r.seq, commandId: r.command_id, kind: r.kind, payload: JSON.parse(r.payload || '{}'),
        created_at: r.created_at, expires_at: r.expires_at
      })}\n\n`);
    }
    const ka = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* поток уже мёртв — снимет close */
      }
    }, 20_000);
    const done = () => {
      clearInterval(ka);
      set.delete(res);
      if (!set.size) streams.delete(node.id);
    };
    req.on('close', done);
    res.on('error', done);
    return null;
  };

  const routes = {
    'GET /healthz': () => {
      const one = (sql) => db.prepare(sql).get()?.c || 0;
      return [200, {
        ok: true, proto: 1, version: '1.0.0',
        nodes: one('SELECT count(*) c FROM nodes'),
        sessions: one('SELECT count(*) c FROM sessions'),
        commands: one('SELECT count(*) c FROM commands')
      }];
    },

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

    'POST /fed/v1/snapshot': async (req) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const body = await readJson(req);
      if (!body.sessionId) return [400, { ok: false, error: 'sessionId required' }];
      saveSnapshot(node.id, body.sessionId, body.messages, body.upToSeq);
      touch(node.id);
      return [200, { ok: true, messages: Array.isArray(body.messages) ? body.messages.length : 0 }];
    },

    'POST /fed/v1/usage': async (req) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const body = await readJson(req);
      const calls = Array.isArray(body.calls) ? body.calls : [];
      const up = db.prepare(
        `INSERT INTO usage (request_id, node, provider, model, ts, in_tokens, out_tokens, cache_read, cost_usd, status, ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(request_id) DO NOTHING`
      );
      let stored = 0;
      db.exec('BEGIN');
      try {
        for (const c of calls) {
          if (!c || !c.request_id) continue;
          const r = up.run(String(c.request_id), node.id, c.provider ?? null, c.model ?? null, c.ts ?? iso(),
            Number.isFinite(c.in_tokens) ? c.in_tokens : null,
            Number.isFinite(c.out_tokens) ? c.out_tokens : null,
            Number.isFinite(c.cache_read) ? c.cache_read : null,
            c.cost_usd == null ? null : String(c.cost_usd),
            c.status ?? null,
            Number.isFinite(c.ms) ? c.ms : null);
          stored += r.changes;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      touch(node.id);
      return [200, { ok: true, stored, skipped: calls.length - stored }];
    },

    // Память федерации: чанки узла/импортёра ложатся в ОДИН ctxdb хаба (docs/FEDERATION.md §6).
    'POST /fed/v1/memory': async (req) => {
      const node = nodeByToken(req);
      const isHub = hubToken && bearer(req) === hubToken;
      if (!node && !isHub) return [401, { ok: false, error: 'unknown-node' }];
      const owner = node?.id || 'hub-import';
      const body = await readJson(req, 32 << 20);
      const chunks = Array.isArray(body.chunks) ? body.chunks : [];
      const ingest = await openMemoryIngest();
      let stored = 0;
      let dupes = 0;
      let bytes = 0;
      for (const c of chunks) {
        if (!c || typeof c.text !== 'string') continue;
        const verdict = ingest.add({
          kind: c.kind || 'chat_user',
          text: c.text,
          project: c.project || c.workspace || '',
          session: c.session || '',
          turn: Number.isFinite(c.turn) ? c.turn : 0,
          ts: c.ts
        });
        if (verdict === 'new') stored++;
        else if (verdict === 'dupe') dupes++;
        if (verdict !== 'short') bytes += Buffer.byteLength(c.text);
      }
      const day = iso().slice(0, 10);
      db.prepare(
        `INSERT INTO memory_ingest (node, day, chunks, dupes, bytes) VALUES (?,?,?,?,?)
         ON CONFLICT(node, day) DO UPDATE SET chunks = chunks + excluded.chunks,
           dupes = dupes + excluded.dupes, bytes = bytes + excluded.bytes`
      ).run(owner, day, stored, dupes, bytes);
      if (node) touch(node.id);
      logAudit(node ? 'node' : 'import', owner, 'memory', null, 'ok', { stored, dupes, chunks: chunks.length });
      return [200, { ok: true, stored, dupes, total_chunks: ingest.count() }];
    },

    // Что уже лежит в общей памяти по узлам: видно отставание бэкфилла, а не «всё хорошо».
    'GET /api/federation/memory/ingest': (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const rows = db.prepare('SELECT node, day, chunks, dupes, bytes FROM memory_ingest ORDER BY day DESC, node LIMIT 200').all();
      return [200, { ok: true, ingest: rows }];
    },

    // Манифест автоматизации узлу: контентный адрес всего набора (docs/FEDERATION.md §9).
    'GET /fed/v1/automation/manifest': (req, url) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const manifest = buildAutomationManifest();
      const since = url.searchParams.get('since');
      if (since && since === manifest.sha) return [304, { ok: true, sha: manifest.sha }];
      touch(node.id);
      return [200, { ok: true, ...manifest }];
    },

    // Один файл манифеста: только то, что есть в манифесте, и только по относительному пути.
    'GET /fed/v1/automation/file': (req, url) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const rel = String(url.searchParams.get('path') || '');
      const found = buildAutomationManifest().files.find((f) => f.path === rel);
      if (!found) return [404, { ok: false, error: 'not-in-manifest' }];
      const home = process.env.DSH_HOME || '/srv/apps/dsh/dsh-home';
      const base = rel.startsWith('skills/') ? join(home, 'skills') : '/srv/apps/dsh/workspaces/pc_admin/scripts';
      const fileName = rel.startsWith('skills/') ? rel.slice('skills/'.length) : rel.replace(/^checks\//, '');
      const full = join(base, fileName);
      if (!existsSync(full)) return [404, { ok: false, error: 'file-gone' }];
      const buf = readFileSync(full);
      if (sha256(buf) !== found.sha256) return [409, { ok: false, error: 'file-changed' }];
      return [200, buf.toString('base64'), 'application/octet-stream', 'base64'];
    },

    // Отчёт узла: что у него реально стоит и совпадает ли с манифестом.
    'POST /fed/v1/automation/report': async (req) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const body = await readJson(req);
      const state = body.applied_sha ? (body.drift?.length ? 'drift' : 'in-sync') : 'failed';
      db.prepare(
        `INSERT INTO node_automation (node, applied_sha, dsh_version, state, drift, last_error, applied_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(node) DO UPDATE SET applied_sha = excluded.applied_sha, dsh_version = excluded.dsh_version,
           state = excluded.state, drift = excluded.drift, last_error = excluded.last_error, applied_at = excluded.applied_at`
      ).run(node.id, body.applied_sha || null, body.dsh_version || null, state,
        JSON.stringify(body.drift || []), body.error || null, iso());
      touch(node.id);
      logAudit('node', node.id, 'automation', null, state, { applied_sha: body.applied_sha ?? null });
      return [200, { ok: true, state }];
    },

    // Запустить раскатку автоматизации на узле (P2d). Узел применит манифест у себя.
    'POST /api/federation/automation/apply': async (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const body = await readJson(req);
      if (!body.node) return [400, { ok: false, error: 'node required' }];
      const cmd = enqueue(body.node, 'automation.apply', {}, 600);
      logAudit('viewer', body.node, 'automation.apply', null, 'queued', { commandId: cmd.commandId });
      return [200, { ok: true, ...cmd }];
    },

    'GET /api/federation/automation': (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const manifest = buildAutomationManifest();
      const nodes = db.prepare('SELECT * FROM node_automation').all();
      return [200, {
        ok: true,
        manifest: { sha: manifest.sha, counts: manifest.counts, bytes: manifest.files.reduce((a, f) => a + f.bytes, 0) },
        nodes: nodes.map((n) => ({ ...n, drift: n.drift ? JSON.parse(n.drift) : [] }))
      }];
    },

    // Ответ узла на команду. Повтор с тем же commandId — не ошибка и не второе исполнение.
    'POST /fed/v1/reply': async (req) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const body = await readJson(req);
      if (!body.commandId) return [400, { ok: false, error: 'commandId required' }];
      const row = db.prepare('SELECT * FROM commands WHERE command_id = ? AND node = ?').get(String(body.commandId), node.id);
      if (!row) return [404, { ok: false, error: 'no-such-command' }];
      if (row.state === 'done' || row.state === 'failed') return [200, { ok: true, duplicate: true, state: row.state }];
      const state = body.ok ? 'done' : 'failed';
      db.prepare('UPDATE commands SET state = ?, result = ? WHERE command_id = ?').run(
        state, JSON.stringify(body.result ?? null), row.command_id);
      logAudit('node', node.id, row.kind, (JSON.parse(row.payload || '{}').sessionId) ?? null, state,
        { commandId: row.command_id, error: body.error ?? null });
      touch(node.id);
      return [200, { ok: true, state }];
    },

    // Запасной путь для отладки: забрать очередь опросом, без SSE.
    'GET /fed/v1/commands': (req, url) => {
      const node = nodeByToken(req);
      if (!node) return [401, { ok: false, error: 'unknown-node' }];
      const since = Number(url.searchParams.get('since') || 0);
      expireStale();
      const rows = db.prepare(
        `SELECT * FROM commands WHERE node = ? AND seq > ? AND state = 'queued' ORDER BY seq LIMIT 50`
      ).all(node.id, since);
      touch(node.id);
      return [200, {
        ok: true,
        commands: rows.map((r) => ({
          seq: r.seq, commandId: r.command_id, kind: r.kind,
          payload: JSON.parse(r.payload || '{}'), created_at: r.created_at, expires_at: r.expires_at
        }))
      }];
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
    },

    // Переписка сессии: снапшот от узла + статус и метаданные из index.
    'GET /api/federation/session': (req, url) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const id = url.searchParams.get('id');
      if (!id) return [400, { ok: false, error: 'id required' }];
      const node = url.searchParams.get('node');
      const s = node
        ? db.prepare('SELECT * FROM sessions WHERE id = ? AND node = ?').get(id, node)
        : db.prepare('SELECT * FROM sessions WHERE id = ? ORDER BY updated_at DESC').get(id);
      if (!s) return [404, { ok: false, error: 'no-such-session' }];
      const snap = db.prepare('SELECT up_to_seq, messages, at FROM snapshots WHERE session_id = ? AND node = ?').get(id, s.node);
      const asked = askSnapshot(s.node, id);
      return [200, {
        ok: true,
        session: s,
        snapshot_at: snap?.at ?? null,
        up_to_seq: snap?.up_to_seq ?? null,
        refreshing: Boolean(asked),
        messages: snap ? JSON.parse(snap.messages) : []
      }];
    },

    'POST /api/federation/prompt': async (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const body = await readJson(req);
      if (!body.node || !body.sessionId || !String(body.text || '').trim()) {
        return [400, { ok: false, error: 'node, sessionId and text required' }];
      }
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(body.node);
      if (!node) return [404, { ok: false, error: 'no-such-node' }];
      const payload = { sessionId: body.sessionId, text: String(body.text) };
      // модель выбирает зритель хаба; узел не подменяет её сам (docs/FEDERATION.md §7)
      if (body.model?.provider && body.model?.model) payload.model = { provider: String(body.model.provider), model: String(body.model.model) };
      const cmd = enqueue(node.id, 'prompt', payload);
      logAudit('viewer', node.id, 'prompt', body.sessionId, 'queued', { commandId: cmd.commandId, chars: String(body.text).length });
      return [200, { ok: true, ...cmd }];
    },

    'POST /api/federation/create': async (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const body = await readJson(req);
      if (!body.node) return [400, { ok: false, error: 'node required' }];
      const cmd = enqueue(body.node, 'create', { cwd: body.cwd ? String(body.cwd) : null }, 120);
      logAudit('viewer', body.node, 'create', null, 'queued', { commandId: cmd.commandId });
      return [200, { ok: true, ...cmd }];
    },

    'GET /api/federation/command': (req, url) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const id = url.searchParams.get('id');
      if (!id) return [400, { ok: false, error: 'id required' }];
      const row = db.prepare('SELECT * FROM commands WHERE command_id = ?').get(id);
      if (!row) return [404, { ok: false, error: 'no-such-command' }];
      return [200, {
        ok: true, commandId: row.command_id, kind: row.kind, state: row.state,
        result: row.result ? JSON.parse(row.result) : null, created_at: row.created_at, expires_at: row.expires_at
      }];
    },

    'POST /api/federation/cancel': async (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const body = await readJson(req);
      if (!body.node || !body.sessionId) return [400, { ok: false, error: 'node and sessionId required' }];
      const cmd = enqueue(body.node, 'cancel', { sessionId: body.sessionId }, 60);
      logAudit('viewer', body.node, 'cancel', body.sessionId, 'queued', { commandId: cmd.commandId });
      return [200, { ok: true, ...cmd }];
    },

    'POST /api/federation/rename': async (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const body = await readJson(req);
      if (!body.node || !body.sessionId || !body.title) return [400, { ok: false, error: 'node, sessionId, title required' }];
      const cmd = enqueue(body.node, 'rename', { sessionId: body.sessionId, title: String(body.title) }, 300);
      logAudit('viewer', body.node, 'rename', body.sessionId, 'queued', { commandId: cmd.commandId });
      return [200, { ok: true, ...cmd }];
    },

    // ── Телефон как устройство: регистрация, выдача команд, приём ответа ──
    'POST /fed/v1/device/hello': async (req) => {
      const body = await readJson(req);
      const existing = deviceByToken(req);
      const info = body.device || {};
      const mode = ['sandbox', 'assist', 'full'].includes(body.mode) ? body.mode : 'sandbox';
      // Не прислали возможности — оставляем прежние: hello раз в 30 с не должен обнулять карточку.
      const caps = body.capabilities ? JSON.stringify(body.capabilities) : null;
      const policies = body.policies ? JSON.stringify(body.policies) : null;
      if (existing) {
        db.prepare('UPDATE devices SET name=?, model=?, android=?, sdk=?, mode=?, capabilities=?, policies=?, last_seen=? WHERE id=?')
          .run(String(info.name || existing.name), info.model || existing.model, info.android || existing.android,
            Number.isFinite(info.sdk) ? info.sdk : existing.sdk, mode, caps ?? existing.capabilities,
            policies ?? existing.policies, iso(), existing.id);
        return [200, { ok: true, deviceId: existing.id, mode, allow: PHONE_KINDS }];
      }
      if (!hubToken || bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      if (!info.name) return [400, { ok: false, error: 'device.name required' }];
      const token = randomBytes(24).toString('hex');
      const id = 'device_' + randomBytes(4).toString('hex');
      db.prepare(
        `INSERT INTO devices (id, name, model, android, sdk, mode, capabilities, policies, token_hash, created_at, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, String(info.name), info.model || null, info.android || null, Number.isFinite(info.sdk) ? info.sdk : null,
        mode, caps, policies, sha256(token), iso(), iso());
      logAudit('device', id, 'device.hello', null, 'paired', { mode, name: info.name });
      return [200, { ok: true, deviceId: id, token, mode, allow: PHONE_KINDS }];
    },

    'GET /fed/v1/device/commands': async (req, url) => {
      const dev = deviceByToken(req);
      if (!dev) return [401, { ok: false, error: 'unknown-device' }];
      touchDevice(dev.id);
      expireDevice();
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const waitMs = Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait') || 0)));
      const deadline = Date.now() + waitMs;
      for (;;) {
        const rows = db.prepare(`SELECT * FROM device_commands WHERE device = ? AND seq > ? AND state = 'queued' ORDER BY seq`)
          .all(dev.id, cursor);
        if (rows.length || Date.now() >= deadline) {
          return [200, {
            ok: true,
            cursor: rows.length ? rows[rows.length - 1].seq : cursor,
            commands: rows.map((r) => ({ seq: r.seq, commandId: r.command_id, kind: r.kind, payload: JSON.parse(r.payload || '{}') })),
            mode: dev.mode
          }];
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    },

    'POST /fed/v1/device/reply': async (req) => {
      const dev = deviceByToken(req);
      if (!dev) return [401, { ok: false, error: 'unknown-device' }];
      const body = await readJson(req);
      const row = body.commandId ? commandRow(String(body.commandId)) : null;
      if (!row || row.device !== dev.id) return [404, { ok: false, error: 'unknown-command' }];
      if (row.state === 'queued' || row.state === 'sent') {
        const state = body.ok ? 'done' : 'error';
        db.prepare('UPDATE device_commands SET state=?, result=?, error=?, done_at=? WHERE command_id=?')
          .run(state, body.result === undefined ? null : JSON.stringify(body.result), body.error ? String(body.error) : null, iso(), row.command_id);
        logAudit('device', dev.id, `phone.${row.kind}`, null, state, body.error ? { error: body.error } : undefined);
        settle(row.command_id, { commandId: row.command_id, kind: row.kind, ok: !!body.ok, result: body.result ?? null, error: body.error ?? null });
      }
      touchDevice(dev.id);
      return [200, { ok: true }];
    },

    // ── Что видит агент и панель: устройства и запрос к телефону ──
    'GET /api/federation/devices': (req) => {
      const who = caller(req);
      if (!who) return [401, { ok: false, error: 'hub-token-required' }];
      const rows = db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
      const now = Date.now();
      return [200, {
        ok: true,
        devices: rows.map((r) => ({
          id: r.id, name: r.name, model: r.model, android: r.android, mode: r.mode,
          capabilities: JSON.parse(r.capabilities || '{}'),
          policies: JSON.parse(r.policies || '{}'),
          online: now - Date.parse(r.last_seen) < 90_000,
          last_seen: r.last_seen, created_at: r.created_at
        }))
      }];
    },

    'POST /api/federation/phone': async (req) => {
      const who = caller(req);
      if (!who) return [401, { ok: false, error: 'hub-token-required' }];
      const body = await readJson(req);
      const kind = String(body.kind || '');
      if (!PHONE_KINDS.includes(kind)) return [400, { ok: false, error: `unknown-kind:${kind}`, allow: PHONE_KINDS }];
      const now = Date.now();
      const devices = db.prepare('SELECT * FROM devices').all();
      const online = devices.filter((d) => now - Date.parse(d.last_seen) < 90_000);
      const dev = body.device ? devices.find((d) => d.id === body.device) : online[0];
      if (!dev) return [409, { ok: false, error: devices.length ? 'device-offline' : 'no-device' }];
      const commandId = randomUUID();
      const ttl = kind === 'shell' ? 90 : 60;
      const expiresAt = new Date(now + ttl * 1000).toISOString();
      db.prepare(
        `INSERT INTO device_commands (command_id, device, kind, payload, created_at, expires_at, state)
         VALUES (?,?,?,?,?,?, 'queued')`
      ).run(commandId, dev.id, kind, JSON.stringify(body.payload ?? {}), iso(), expiresAt);
      logAudit(who.actor, dev.id, `phone.${kind}`, null, 'queued', body.payload ? { payload: body.payload } : undefined);
      const waitMs = Math.min(90_000, Math.max(0, Number(body.waitMs ?? 15_000)));
      const value = waitMs ? await waitFor(commandId, waitMs) : null;
      const row = commandRow(commandId);
      if (!value && !waitMs) return [200, { ok: true, accepted: true, commandId, device: dev.id, state: row.state }];
      if (!value) {
        return [202, { ok: false, pending: true, commandId, device: dev.id, state: row.state, error: row.error || 'timeout' }];
      }
      return [value.ok ? 200 : 422, { ok: value.ok, commandId, device: dev.id, kind, result: value.result, error: value.error }];
    },

    'GET /api/federation/phone/result': (req, url) => {
      const who = caller(req);
      if (!who) return [401, { ok: false, error: 'hub-token-required' }];
      const row = commandRow(String(url.searchParams.get('commandId') || ''));
      if (!row) return [404, { ok: false, error: 'unknown-command' }];
      return [200, { ok: true, ...commandView(row) }];
    },

    // ── Токен шлюза моделей: узлу не нужен ключ провайдера, только пропуск на хаб ──
    'POST /api/federation/node/llm-token': async (req) => {
      if (!hubToken || bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const body = await readJson(req);
      const target = String(body.node || '');
      if (!target) return [400, { ok: false, error: 'node required' }];
      const token = llm.mint(target, 'node');
      logAudit('viewer', target, 'llm.token-issued', null, 'ok');
      return [200, { ok: true, node: target, token, models: llm.models, baseURL: '/llm' }];
    },

    'GET /api/federation/llm/stats': (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      return [200, {
        ok: true,
        models: llm.models,
        by_node: db.prepare('SELECT node, count(*) calls, sum(in_tokens) i, sum(out_tokens) o FROM usage WHERE provider = ? GROUP BY node').all('deepseek-account'),
        recent: db.prepare('SELECT node, model, ts, in_tokens, out_tokens, status, ms FROM usage WHERE provider = ? ORDER BY ts DESC LIMIT 20').all('deepseek-account')
      }];
    },

    'GET /api/federation/audit': (req, url) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
      const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
      return [200, {
        ok: true,
        audit: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }))
      }];
    },

    // Статистика: узлы, сессии, команды по состояниям, токены и деньги (деньги — строками, не float).
    'GET /api/federation/stats': (req) => {
      if (hubToken && bearer(req) !== hubToken) return [401, { ok: false, error: 'hub-token-required' }];
      expireStale();
      const one = (sql, ...args) => db.prepare(sql).get(...args) || {};
      return [200, {
        ok: true,
        nodes: one('SELECT count(*) c FROM nodes').c || 0,
        sessions: one('SELECT count(*) c FROM sessions').c || 0,
        snapshots: one('SELECT count(*) c FROM snapshots').c || 0,
        commands: db.prepare('SELECT state, count(*) c FROM commands GROUP BY state').all(),
        usage: one('SELECT count(*) c, sum(in_tokens) i, sum(out_tokens) o, sum(cache_read) r FROM usage'),
        memory_ingest: db.prepare('SELECT node, day, chunks, dupes FROM memory_ingest ORDER BY day DESC LIMIT 5').all(),
        by_model: db.prepare('SELECT model, count(*) c, sum(in_tokens) i, sum(out_tokens) o FROM usage GROUP BY model ORDER BY c DESC LIMIT 20').all(),
        checked_at: iso()
      }];
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, 'text/html; charset=utf-8', dashboardHtml());
    if (req.method === 'GET' && url.pathname === '/fed/v1/stream') return handleStream(req, res, url);
    // Шлюз моделей сам отвечает и сам решает, его ли путь: /llm/v1/messages
    if (url.pathname.startsWith('/llm/')) {
      try {
        await llm.handle(req, res, url);
      } catch (e) {
        if (!res.headersSent) json(res, 502, { type: 'error', error: { type: 'api_error', message: `hub gateway: ${e.message}` } });
        else res.end();
      }
      return;
    }
    const handler = routes[key];
    if (!handler) return json(res, 404, { ok: false, error: 'not-found' });
    try {
      const out = await handler(req, url);
      if (out[3] === 'base64') {
        const buf = Buffer.from(out[1], 'base64');
        res.writeHead(out[0], { 'content-type': out[2], 'content-length': buf.length });
        return res.end(buf);
      }
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
  const code = arg('code', process.env.DSH_HUB_PAIR_CODE || '');
  const host = arg('host', process.env.DSH_HUB_HOST || '127.0.0.1');
  const hubToken = arg('hub-token', process.env.DSH_HUB_TOKEN || '');
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
  const hub = createHub({
    dbPath, pairCode: code, hubToken, vaultPath,
    llmUpstream: process.env.DSH_LLM_UPSTREAM || undefined,
    credentialsPaths: process.env.DSH_CREDENTIALS_FILE ? [process.env.DSH_CREDENTIALS_FILE] : []
  });
  hub.server.listen(port, host, () => {
    console.log(`dsh_hub listening http://${host}:${port} db=${dbPath} pair=${code ? 'on' : 'OFF'}`);
  });
}
