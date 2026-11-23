// Прокси моделей на хабе (ТЗ P3a: «единственные ворота»).
//
// Зачем: узлу и телефону не нужны свои ключи LLM — он ходит к хабу, хаб проверяет
// allowlist и пересылает запрос в DeepSeek с токеном аккаунта, который лежит на хабе.
//
// Контракт: узел монтирует штатный @deepseek-ai/dsh-llm-deepseek-api-key с
// baseURL = http://<хаб>:18990/llm и apiKeyEnv = DSH_FED_LLM_TOKEN (токен выдаёт хаб).
// Провайдер сам зовёт POST /llm/v1/messages с заголовком x-api-key — его мы и проверяем.
//
// Потолок (осознанно): токен аккаунта читается из .credentials.yaml на каждый запрос,
// обновляет его dsh-web; если он протух, узел получит 401, а не тихо чужой ключ.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const iso = () => new Date().toISOString();

/** Токен аккаунта DeepSeek из хранилища кредов DSH (records.deepseek-account-platform/default.payload.token). */
export function accountToken(paths = []) {
  const candidates = [
    ...paths,
    process.env.DSH_CREDENTIALS_FILE,
    '/srv/apps/dsh/dsh-home/.credentials.yaml',
    join(homedir(), '.dsh', '.credentials.yaml')
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const yaml = readFileSync(p, 'utf8');
      // Без yaml-парсера: находим ключ записи и читаем её вложенные строки до равного отступа.
      const lines = yaml.split('\n');
      const head = lines.findIndex((l) => /^\s*deepseek-account-platform\/default:\s*$/.test(l));
      if (head >= 0) {
        const indent = lines[head].match(/^\s*/)[0].length;
        const block = [];
        for (const line of lines.slice(head + 1)) {
          const lead = line.match(/^\s*/)[0].length;
          if (line.trim() && lead <= indent) break;
          block.push(line);
        }
        const token = /^\s+token:\s*(\S+)\s*$/m.exec(block.join('\n'));
        if (token) return { token: token[1], file: p };
      }
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}

/** Модели, которые хаб пускает наружу. Умолчание — две официальные. */
const DEFAULT_ALLOW = ['deepseek-flash', 'deepseek-v4-pro'];

/**
 * Шлюз: проверка токена, allowlist, пересылка потока, учёт usage и аудит.
 * @returns обработчик запроса (сам решает, его ли это путь) и функции выдачи токенов
 */
export function createLlmGateway({ db, upstream = 'https://api.deepseek.com/anthropic', allow = null, logAudit = () => {}, credentialsPaths = [] } = {}) {
  const models = allow || (process.env.DSH_LLM_ALLOW ? process.env.DSH_LLM_ALLOW.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOW);

  const tokenRow = (key) => (key ? db.prepare('SELECT * FROM llm_tokens WHERE key_hash = ?').get(sha256(key)) : null);

  /** Выдать (или перевыдать) токен шлюза узлу: одна строка на цель, старый гаснет. */
  const mint = (target, kind = 'node') => {
    const key = randomBytes(24).toString('hex');
    db.prepare('DELETE FROM llm_tokens WHERE target = ?').run(target);
    db.prepare('INSERT INTO llm_tokens (key_hash, target, kind, created_at) VALUES (?,?,?,?)')
      .run(sha256(key), target, kind, iso());
    return key;
  };

  const record = (row, status, inT = 0, outT = 0, cache = 0, ms = 0, model = null) =>
    db.prepare(
      `INSERT INTO usage (request_id, node, provider, model, ts, in_tokens, out_tokens, cache_read, cost_usd, status, ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(randomUUID(), row?.target ?? null, 'deepseek-account', model, iso(), inT, outT, cache, null, String(status), ms);

  /** usage из потока SSE: message_start несёт входные токены, message_delta — выходные. */
  const scanUsage = (text, acc) => {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      const u = ev?.usage ?? ev?.message?.usage;
      if (!u) continue;
      if (Number.isFinite(u.input_tokens)) acc.in = Math.max(acc.in, u.input_tokens);
      if (Number.isFinite(u.output_tokens)) acc.out = Math.max(acc.out, u.output_tokens);
      if (Number.isFinite(u.cache_read_input_tokens)) acc.cache = Math.max(acc.cache, u.cache_read_input_tokens);
    }
  };

  const deny = (res, status, type, message, row, model) => {
    record(row, status, 0, 0, 0, 0, model);
    logAudit('gateway', row?.target ?? null, 'llm.deny', null, String(status), { model, message });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  };

  return {
    models,
    mint,
    /** true — путь наш, ответ отправлен (или отправляется асинхронно через res). */
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/llm/')) return false;
      if (req.method !== 'POST' || !/\/v1\/messages$/.test(url.pathname)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${req.method} ${url.pathname}` } }));
        return true;
      }
      const row = tokenRow(req.headers['x-api-key'] || '');
      if (!row) return deny(res, 401, 'authentication_error', 'hub: unknown gateway token', null, null), true;

      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return deny(res, 400, 'invalid_request_error', 'hub: body is not JSON', row, null), true;
      }
      const model = String(body.model || '');
      if (!models.includes(model)) {
        return deny(res, 403, 'permission_error', `hub: model "${model}" is not allowed by federation policy; allowed: ${models.join(', ')}`, row, model);
      }

      const cred = accountToken(credentialsPaths);
      if (!cred) return deny(res, 503, 'api_error', 'hub: DeepSeek account token is not configured on the hub', row, model), true;

      const started = Date.now();
      const headers = {
        'content-type': 'application/json',
        accept: req.headers.accept || 'text/event-stream',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'x-dsh-auth-token': cred.token
      };
      if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];

      let upstreamRes;
      try {
        upstreamRes = await fetch(`${upstream}/v1/messages`, { method: 'POST', headers, body: raw });
      } catch (e) {
        record(row, 502, 0, 0, 0, Date.now() - started, model);
        logAudit('gateway', row.target, 'llm.error', null, '502', { model, error: e.message });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `hub: upstream unreachable: ${e.message}` } }));
        return true;
      }

      const acc = { in: 0, out: 0, cache: 0, carry: '' };
      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') || 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no'
      });
      try {
        for await (const piece of upstreamRes.body) {
          res.write(piece);
          const text = acc.carry + Buffer.from(piece).toString('utf8');
          const cut = text.lastIndexOf('\n');
          scanUsage(cut >= 0 ? text.slice(0, cut) : '', acc);
          acc.carry = cut >= 0 ? text.slice(cut + 1) : text;
        }
        scanUsage(acc.carry, acc);
      } catch (e) {
        logAudit('gateway', row.target, 'llm.stream-error', null, 'error', { model, error: e.message });
      } finally {
        res.end();
        record(row, upstreamRes.status, acc.in, acc.out, acc.cache, Date.now() - started, model);
        logAudit('gateway', row.target, 'llm.call', null, String(upstreamRes.status), { model, tokens: acc.in + acc.out });
      }
      return true;
    }
  };
}
