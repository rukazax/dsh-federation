#!/usr/bin/env node
// Импорт журналов сессий DSH в общий RAG хаба.
//
//   node tools/import-sessions.mjs --dir <корень sessions> [--hub URL] [--project-prefix win] [--limit N] [--dry]
//
// Читает session.v4.jsonl.zstd (zstd -dc, без пересжатия — запись не трогаем), достаёт
// сообщения пользователя и ассистента, режет на чанки по ~1000 знаков и отправляет в
// POST /fed/v1/memory. Инъекции рантайма (runtime-context/time-context) не импортируются.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const dir = arg('dir', '');
const hub = (arg('hub', 'http://127.0.0.1:18990') || '').replace(/\/$/, '');
const tokenFile = arg('token-file', '/srv/apps/dsh/federation/hub-token');
const limit = Number(arg('limit', '0')) || 0;
const chunkChars = Number(arg('chunk-chars', '1000')) || 1000;
const dry = flag('dry');
if (!dir) {
  console.error('нужно: --dir <корень sessions>');
  process.exit(2);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();

const walk = (root, acc = []) => {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name === 'session.v4.jsonl.zstd') acc.push(full);
  }
  return acc;
};

const decompress = (file) => {
  const r = spawnSync('zstd', ['-dc', file], { maxBuffer: 512 << 20 });
  if (r.status !== 0) throw new Error(`zstd: ${r.stderr?.toString().slice(0, 200)}`);
  return r.stdout.toString('utf8');
};

const textOf = (data) => {
  const payload = data?.message ?? data ?? {};
  const blocks = payload.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
};

/** Плоские чанки из журнала: по сообщению, длинные режем по границам строк. */
export function chunksOfSession(raw, { project, session, chunkChars = 1000 }) {
  const out = [];
  let turn = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const type = ev?.type;
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const d = ev.data ?? {};
    const srcKind = d?.message?.source?.kind ?? d?.source?.kind;
    if (srcKind === 'runtime-context' || srcKind === 'time-context') continue;
    const text = textOf(d);
    if (!text) continue;
    const kind = type === 'user/message' ? 'chat_user' : 'chat_assistant';
    turn++;
    for (let i = 0; i < text.length; i += chunkChars) {
      const piece = text.slice(i, i + chunkChars).trim();
      if (piece.length < 24) continue;
      out.push({
        kind,
        text: piece,
        project,
        session,
        turn,
        ts: Number.isFinite(ev.time) ? ev.time : Date.now()
      });
    }
  }
  return out;
}

const post = async (chunks) => {
  const res = await fetch(`${hub}/fed/v1/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ chunks })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};

const files = walk(dir);
console.log(`файлов журналов: ${files.length}${limit ? `, берём ${limit}` : ''}`);
let sent = 0;
let stored = 0;
let dupes = 0;
let batch = [];
let sessions = 0;

const flush = async () => {
  if (!batch.length) return;
  if (dry) {
    console.log(`[dry] отправили бы ${batch.length} чанков`);
  } else {
    const r = await post(batch);
    stored += r.stored;
    dupes += r.dupes;
  }
  sent += batch.length;
  batch = [];
};

for (const file of limit ? files.slice(0, limit) : files) {
  const rel = path.relative(dir, file);
  const parts = rel.split(path.sep);
  const project = parts[0];
  const session = parts[1] || path.basename(path.dirname(file));
  let raw;
  try {
    raw = decompress(file);
  } catch (e) {
    console.error(`пропуск ${rel}: ${e.message}`);
    continue;
  }
  const chunks = chunksOfSession(raw, { project, session, chunkChars });
  sessions++;
  batch.push(...chunks);
  while (batch.length >= 200) {
    const head = batch.slice(0, 200);
    batch = batch.slice(200);

    if (dry) {
      console.log(`[dry] ${rel}: ${chunks.length} чанков (было бы отправлено ${head.length})`);
      sent += head.length;
    } else {
      const r = await post(head);
      stored += r.stored;
      dupes += r.dupes;
      sent += head.length;
    }
  }
  if (sessions % 25 === 0) console.log(`… ${sessions} сессий, ${sent} чанков (новых ${stored}, дублей ${dupes})`);
}
await flush();
console.log(`итого: сессий ${sessions}, чанков ${dry ? '(dry) ' : ''}${sent}, новых ${stored}, дублей ${dupes}`);

if (dry) process.exit(0);
const stats = await fetch(`${hub}/api/federation/stats`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
console.log('хаб:', JSON.stringify({ memory_ingest: stats.memory_ingest?.slice(0, 3) }));
