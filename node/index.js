// dsh_hub — узел федерации в профиле DSH.
//
// Что делает: спаривается с хабом (файл ~/.dsh/federation/node.json, его пишет bin/pair.mjs),
// отдаёт хабу список своих сессий (index), слушает поток команд (SSE) и исполняет их **у себя**:
// prompt / cancel / rename / snapshot. Ход исполняется только на этом устройстве — хаб лишь
// ставит команду в очередь (правило федерации, docs/FEDERATION.md §1).
//
// Конфиг файлом, а не схемой: профиль монтируется из cordis.patch.yml без Config —
// лишняя схема тут ничего не проверяет, а файл правится руками и переживает обновления.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const name = 'dsh-hub-node';
export const inject = ['sessionController'];
export const Config = undefined;

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DIR = path.join(HOME, 'federation');
const PAIR = path.join(DIR, 'node.json');
const STATE = path.join(DIR, 'node-state.json');
const LOG = path.join(DIR, 'node.log');
const INDEX_MS = 60_000;
const SNAPSHOT_MESSAGES = 300;

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 1));
};

/** Журнал узла: ctx.logger в journald виден не всегда, а без него не отладить спаривание. */
const trace = (message) => {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* журнал не критичен */
  }
};

/** Текст одного сообщения из блоков content: размышления и вызовы инструментов не уходят. */
export function messageText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** События сессии → плоская переписка для хаба. Роли те же, что в журнале, без догадок. */
export function toMessages(records) {
  const out = [];
  for (const rec of records || []) {
    const ev = rec?.event;
    if (!ev || !ev.type) continue;
    let role = null;
    if (ev.type === 'user/message') role = 'user';
    else if (ev.type === 'assistant/message') role = 'assistant';
    else if (ev.type === 'tool/result') role = 'tool';
    if (!role) continue;
    // Инъекции рантайма (контекст каталога, время) — не переписка: в UI хаба им не место.
    const sourceKind = ev.data?.message?.source?.kind ?? ev.data?.source?.kind;
    if (role === 'user' && (sourceKind === 'runtime-context' || sourceKind === 'time-context')) continue;
    // Форма события тоже разная по версиям: 0.2.2 кладёт сообщение в data.message,
    // 0.2.1 — прямо в data (content/role/id на верхнем уровне).
    const payload = ev.data?.message ?? ev.data ?? {};
    const text = role === 'tool'
      ? String(payload.result ?? payload.text ?? '').slice(0, 2000)
      : messageText(payload.content);
    if (!text) continue;
    out.push({ role, text, seq: ev.seq ?? null, at: ev.time ? new Date(ev.time).toISOString() : null });
  }
  return out;
}

/** Строка сессии → индекс для хаба. Заголовок берём из проекции, а не из текста на глаз. */
export function toIndexRow(row) {
  const title = row?.projections?.values?.title;
  return {
    id: String(row.sessionId),
    title: typeof title === 'string' && title.trim() ? title.trim() : null,
    cwd: row.cwd ?? null,
    status: row.running ? 'running' : 'idle',
    updated_at: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    turns: Number.isFinite(row.turns) ? row.turns : null,
    size: Number.isFinite(row.size) ? row.size : null
  };
}

/** Остановить активный узел: нужно тестам и выгрузке плагина. */
let stopActive = () => {};
export function stopActiveNode() {
  stopActive();
}

export function apply(ctx) {
  const pair = readJson(PAIR, null);
  if (!pair?.hub || !pair?.token) {
    trace('не спарен: нет node.json — запусти bin/pair.mjs --hub <url> --code <код>');
    return;
  }
  const hub = String(pair.hub).replace(/\/$/, '');
  const state = readJson(STATE, { cursor: 0 });
  const executed = new Set();
  let stop = false;
  stopActive = () => {
    stop = true;
  };

  const saveState = () => {
    try {
      writeJson(STATE, state);
    } catch {
      /* состояние не критично: переживём повтор команды по commandId */
    }
  };

  const api = async (method, route, body, ms = 20_000) => {
    const res = await fetch(`${hub}${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pair.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms)
    });
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };

  const sc = () => ctx.sessionController;

  const pushIndex = async () => {
    const page = await sc().list({}, AbortSignal.timeout(30_000));
    const sessions = (page.items || []).filter((r) => r.origin !== 'subagent').map(toIndexRow);
    const out = await api('POST', '/fed/v1/index', { sessions });
    state.lastIndex = new Date().toISOString();
    saveState();
    trace(`index: ${sessions.length} сессий, хаб принял ${out.upserted ?? '?'}`);
    return sessions.length;
  };

  /**
   * Чтение истории разными формами запроса: набор полей page() менялся между версиями DSH.
   * Сначала пробуем ту форму, что уже сработала (state.pageShape), потом остальные.
   */
  const probeMethods = () => {
    const out = [];
    for (const k of ['page', 'events', 'state', 'wait', 'follow', 'projections', 'observeEvent', 'list', 'create', 'prompt', 'cancel', 'rename']) {
      try {
        out.push(`${k}:${typeof sc()[k]}`);
      } catch {
        out.push(`${k}:err`);
      }
    }
    return out.join(' ');
  };

  const sessionRow = async (sessionId) => {
    const page = await sc().list({}, AbortSignal.timeout(20_000));
    return (page.items || []).find((r) => String(r.sessionId) === String(sessionId)) || null;
  };

  /** Последний seq журнала: в 0.2.1 его даёт проекция (asOfSeq), в новых версиях — сам page(). */
  const lastSeq = async (sessionId) => {
    try {
      if (typeof sc().projections === 'function') {
        const pr = await sc().projections({ sessionId }, AbortSignal.timeout(20_000));
        if (pr && Number.isInteger(pr.asOfSeq)) return pr.asOfSeq;
      }
    } catch (e) {
      trace(`projections ${sessionId}: ${e.message}`);
    }
    try {
      const row = await sessionRow(sessionId);
      if (Number.isInteger(row?.projections?.asOfSeq)) return row.projections.asOfSeq;
    } catch {
      /* останется -1 */
    }
    return null;
  };

  /**
   * Чтение истории: набор полей page() менялся между версиями DSH.
   * 0.2.1 требует throughSeq (последний seq), новые версии берут его сами.
   * Пробуем по очереди и запоминаем удачную форму.
   */
  const pageAny = async (sessionId) => {
    const address = { kind: 'session', sessionId };
    const seq = await lastSeq(sessionId);
    const base = [
      ...(seq !== null ? [{ address, throughSeq: seq, maxMessages: SNAPSHOT_MESSAGES }] : []),
      { address, maxMessages: SNAPSHOT_MESSAGES },
      { address, throughSeq: -1, maxMessages: SNAPSHOT_MESSAGES },
      { address }
    ];
    const worked = state.pageShape;
    const shapes = worked
      ? [JSON.parse(worked), ...base.filter((x) => JSON.stringify(x) !== worked)]
      : base;
    let lastError = null;
    for (const req of shapes) {
      try {
        const page = await sc().page(req, AbortSignal.timeout(30_000));
        trace(`page форма ${JSON.stringify(req)} → records=${(page.records || []).length}`);
        if ((page.records || []).length > 0) {
          state.pageShape = JSON.stringify(req);
          saveState();
        }
        return page;
      } catch (e) {
        lastError = e;
        trace(`page форма ${JSON.stringify(req)} → отказ: ${e.message}`);
      }
    }
    throw lastError || new Error('page: ни одна форма запроса не подошла');
  };

  const pushSnapshot = async (sessionId) => {
    const page = await pageAny(sessionId);
    const types = (page.records || []).map((r) => r?.event?.type).slice(0, 12);
    trace(`page ${sessionId}: records=${(page.records || []).length} cursor=${page.cursor} types=${types.join(',')}`);
    const messages = toMessages(page.records);
    // курсор снапшота: свой у новых версий, иначе последний seq журнала
    const upToSeq = Number.isInteger(page.cursor) ? page.cursor : await lastSeq(sessionId);
    await api('POST', '/fed/v1/snapshot', { sessionId, upToSeq, messages });
    trace(`snapshot ${sessionId}: ${messages.length} сообщений`);
    return messages.length;
  };

  /**
   * Дождаться конца хода и отдать хабу свежую переписку.
   * Набор методов отличается по версиям: state → wait → опрос list().running → пауза.
   */
  const snapshotWhenIdle = async (sessionId, maxMs = 15 * 60_000) => {
    const deadline = Date.now() + maxMs;
    const hasState = typeof sc().state === 'function';
    const hasWait = typeof sc().wait === 'function';
    let idleSeen = 0;
    while (!stop && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, hasState ? 2000 : 3000));
      try {
        if (hasState) {
          const st = await sc().state({ sessionId }, AbortSignal.timeout(15_000));
          idleSeen = st.running || st.active ? 0 : idleSeen + 1;
        } else if (hasWait) {
          await sc().wait({ sessionId, timeoutMs: 30_000 });
          return await pushSnapshot(sessionId);
        } else {
          const row = await sessionRow(sessionId);
          idleSeen = row?.running ? 0 : idleSeen + 1;
        }
        if (idleSeen >= (hasState ? 1 : 2)) return await pushSnapshot(sessionId);
      } catch (e) {
        trace(`ожидание ${sessionId}: ${e.message} — снимаю снапшот как есть`);
        return await pushSnapshot(sessionId).catch(() => null);
      }
    }
    return null;
  };

  const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

  /**
   * Раскатка автоматизации: манифест профиля хаба → локальный профиль узла.
   * Только файлы (скиллы и чек-скрипты): патчи ядра требуют root и остаются ручным шагом.
   * Пишем через временный файл и rename — полу-состояния не бывает.
   */
  const applyAutomation = async () => {
    const manifest = await api('GET', '/fed/v1/automation/manifest');
    const drift = [];
    let written = 0;
    let skipped = 0;
    for (const f of manifest.files || []) {
      if (!f.path || f.path.includes('..')) continue;
      const dest = path.join(HOME, f.path);
      let local = null;
      try {
        local = sha256(fs.readFileSync(dest));
      } catch {
        local = null;
      }
      if (local === f.sha256) {
        skipped++;
        continue;
      }
      const raw = await fetch(`${hub}/fed/v1/automation/file?path=${encodeURIComponent(f.path)}`, {
        headers: { authorization: `Bearer ${pair.token}` }
      });
      if (!raw.ok) {
        drift.push({ path: f.path, reason: `fetch ${raw.status}` });
        continue;
      }
      const buf = Buffer.from(await raw.arrayBuffer());
      if (sha256(buf) !== f.sha256) {
        drift.push({ path: f.path, reason: 'sha-mismatch' });
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      written++;
      if (local !== null) drift.push({ path: f.path, reason: 'outdated' });
    }
    await api('POST', '/fed/v1/automation/report', {
      applied_sha: manifest.sha,
      dsh_version: process.env.DSH_VERSION || null,
      drift
    });
    state.automation = { applied_sha: manifest.sha, at: new Date().toISOString(), written, skipped };
    saveState();
    trace(`automation: sha=${manifest.sha} записано ${written}, без изменений ${skipped}, дрейф ${drift.length}`);
    return { applied_sha: manifest.sha, written, skipped, drift };
  };

  const handle = async (ev) => {
    if (executed.has(ev.commandId)) {
      trace(`повтор команды ${ev.commandId} — пропускаю`);
      return;
    }
    executed.add(ev.commandId);
    if (executed.size > 500) executed.delete(executed.values().next().value);
    state.cursor = Math.max(state.cursor || 0, ev.seq || 0);
    saveState();
    const p = ev.payload || {};
    try {
      if (ev.kind === 'prompt') {
        if (p.model?.provider && p.model?.model && typeof sc().selectModel === 'function') {
          await sc().selectModel({ sessionId: p.sessionId, provider: p.model.provider, model: p.model.model });
        }
        await sc().prompt(
          { requestId: randomUUID(), sessionId: p.sessionId, mode: 'queue', content: [{ type: 'text', text: String(p.text || '') }] },
          AbortSignal.timeout(30_000)
        );
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true, result: { accepted: true } });
        // ход пошёл: переписку отдадим, когда он закончится, — не блокируя поток команд
        void snapshotWhenIdle(p.sessionId).catch((e) => trace(`snapshot после хода: ${e.message}`));
      } else if (ev.kind === 'cancel') {
        sc().cancel({ sessionId: p.sessionId });
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true });
        void snapshotWhenIdle(p.sessionId, 60_000).catch(() => {});
      } else if (ev.kind === 'rename') {
        await sc().rename({ sessionId: p.sessionId, title: String(p.title || '') });
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true });
        void pushIndex().catch(() => {});
      } else if (ev.kind === 'snapshot') {
        const n = await pushSnapshot(p.sessionId);
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true, result: { messages: n } });
      } else if (ev.kind === 'create') {
        // новая сессия на этом узле: cwd необязателен, профиль решит сам
        const created = await sc().create(p.cwd ? { cwd: String(p.cwd) } : {});
        const sessionId = created?.session?.sessionId ?? created?.sessionId ?? null;
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true, result: { sessionId } });
        void pushIndex().catch(() => {});
      } else if (ev.kind === 'automation.apply') {
        const result = await applyAutomation();
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true, result });
      } else if (ev.kind === 'index') {
        const n = await pushIndex();
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true, result: { sessions: n } });
      } else {
        await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: false, error: `unsupported-kind:${ev.kind}` });
      }
    } catch (e) {
      trace(`команда ${ev.kind} ${ev.commandId}: ${e.message}`);
      await api('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: false, error: e.message }).catch(() => {});
    }
  };

  /** Поток команд: пока связь жива — читаем SSE, при разрыве переподключаемся с курсора. */
  const streamLoop = async () => {
    let backoff = 2000;
    while (!stop) {
      try {
        const res = await fetch(`${hub}/fed/v1/stream?cursor=${state.cursor || 0}`, {
          headers: { authorization: `Bearer ${pair.token}` }
        });
        if (!res.ok) throw new Error(`stream → ${res.status}`);
        trace('поток команд открыт');
        backoff = 2000;
        const reader = res.body.getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              await handle(JSON.parse(line.slice(6)));
            } catch (e) {
              trace(`разбор события: ${e.message}`);
            }
          }
        }
      } catch (e) {
        trace(`поток оборвался: ${e.message}`);
      }
      if (stop) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  };

  /** Модели, о которых узел знает: хаб по ним рисует выбор и поймёт, что запрашивать. */
  const seenModels = async () => {
    try {
      const cat = await sc().modelCatalog();
      const list = [];
      for (const it of cat?.items ?? cat?.models ?? []) {
        const provider = it.provider?.id ?? it.provider ?? it.providerId;
        const model = it.id ?? it.model;
        if (provider && model) list.push({ provider: String(provider), model: String(model) });
      }
      return list.slice(0, 100);
    } catch (e) {
      trace(`modelCatalog: ${e.message}`);
      return [];
    }
  };

  const hello = async () => {
    const out = await api('POST', '/fed/v1/hello', {
      proto: 1,
      node: { name: pair.name || os.hostname(), version: process.env.DSH_VERSION || null, os: `${os.platform()}-${os.release()}`, host: os.hostname() },
      capabilities: { prompt: true, cancel: true, rename: true, snapshot: true, index: true },
      models_seen: await seenModels()
    });
    state.lastHello = new Date().toISOString();
    saveState();
    trace(`hello ok: nodeId=${out.nodeId} allowlist=${JSON.stringify(out.allowlist || [])}`);
  };

  const start = async () => {
    try {
      await hello();
      await pushIndex();
    } catch (e) {
      trace(`старт: ${e.message} — повторю в фоне`);
    }
    void streamLoop();
    const timer = setInterval(() => {
      pushIndex().catch((e) => trace(`index по таймеру: ${e.message}`));
    }, INDEX_MS);
    timer.unref?.();
  };

  void start();
  ctx.logger?.info?.(`[dsh-hub-node] узел ${pair.name || os.hostname()} → ${hub}`);
}
