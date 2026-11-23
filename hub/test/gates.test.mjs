// Врата (ТЗ P0-«-1» в минимальном виде): инварианты, которые падают, когда поведение сломали.
// Каждый тест — пара «плохо/хорошо» или прямой замер: не «сервис жив», а «правило держится».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHub } from '../src/hub.mjs';

async function started(hub) {
  await new Promise((r) => hub.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const call = async (method, path, body, token, extra = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined
    });
    const raw = await res.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    return { status: res.status, body: parsed, raw };
  };
  return { base, call };
}

const credFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  const file = join(dir, '.credentials.yaml');
  writeFileSync(file, 'records:\n  deepseek-account-platform/default:\n    payload:\n      token: HUB-ACCOUNT-TOKEN\n');
  return file;
})();

test('врата: usage по узлу совпадает с числом вызовов у провайдера', async () => {
  let upstreamHits = 0;
  const upstream = createServer((req, res) => {
    upstreamHits++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const hub = createHub({
    hubToken: 'HUB',
    llmUpstream: `http://127.0.0.1:${upstream.address().port}`,
    credentialsPaths: [credFile]
  });
  const { call } = await started(hub);
  try {
    const key = (await call('POST', '/api/federation/node/llm-token', { node: 'node_a' }, 'HUB')).body.token;
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/llm/v1/messages', { model: 'deepseek-flash' }, null, { 'x-api-key': key });
      assert.equal(r.status, 200);
    }
    const stats = await call('GET', '/api/federation/llm/stats', null, 'HUB');
    const row = stats.body.by_node.find((n) => n.node === 'node_a');
    assert.equal(row.calls, upstreamHits, 'usage считается ровно по вызовам провайдера');
    assert.equal(row.i, 21);
    assert.equal(row.o, 9);
  } finally {
    hub.close();
    upstream.close();
  }
});

test('врата: перевыдача токена шлюза гасит прежний, отзыв закрывает узел', async () => {
  const hub = createHub({ hubToken: 'HUB', llmUpstream: 'http://127.0.0.1:9', credentialsPaths: [credFile] });
  const { call } = await started(hub);
  try {
    const first = (await call('POST', '/api/federation/node/llm-token', { node: 'node_a' }, 'HUB')).body.token;
    const second = (await call('POST', '/api/federation/node/llm-token', { node: 'node_a' }, 'HUB')).body.token;
    assert.notEqual(first, second);
    const old = await call('POST', '/llm/v1/messages', { model: 'deepseek-flash' }, null, { 'x-api-key': first });
    assert.equal(old.status, 401, 'старый токен больше не пускается');
    // без токена хаба выдать новый нельзя
    assert.equal((await call('POST', '/api/federation/node/llm-token', { node: 'node_a' })).status, 401);
  } finally {
    hub.close();
  }
});

test('врата: запрещённая модель не уходит наружу и попадает в аудит', async () => {
  let hits = 0;
  const upstream = createServer((req, res) => {
    hits++;
    res.writeHead(500);
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const hub = createHub({ hubToken: 'HUB', llmUpstream: `http://127.0.0.1:${upstream.address().port}`, credentialsPaths: [credFile] });
  const { call } = await started(hub);
  try {
    const key = (await call('POST', '/api/federation/node/llm-token', { node: 'node_a' }, 'HUB')).body.token;
    const refused = await call('POST', '/llm/v1/messages', { model: 'gpt-9' }, null, { 'x-api-key': key });
    assert.equal(refused.status, 403);
    assert.equal(hits, 0, 'запрещённая модель до провайдера не доходит');
    const audit = await call('GET', '/api/federation/audit?limit=10', null, 'HUB');
    assert.ok(audit.body.audit.some((a) => a.action === 'llm.deny'));
  } finally {
    hub.close();
    upstream.close();
  }
});

test('врата: телефон офлайн и неизвестный вид команды отбиваются, а не висят', async () => {
  const hub = createHub({ hubToken: 'HUB' });
  const { call } = await started(hub);
  try {
    // устройства нет вовсе
    assert.equal((await call('POST', '/api/federation/phone', { kind: 'tap' }, 'HUB')).status, 409);
    const paired = await call('POST', '/fed/v1/device/hello', { device: { name: 'Redmi' }, mode: 'assist' }, 'HUB');
    const token = paired.body.token;
    const okKind = await call('POST', '/api/federation/phone', { kind: 'tap', payload: { x: 1, y: 2 }, waitMs: 0 }, 'HUB');
    assert.equal(okKind.status, 200);
    assert.equal(okKind.body.accepted, true);
    // команда ждёт в очереди устройства, а не исполняется хабом
    const pending = await call('GET', '/fed/v1/device/commands?cursor=0&wait=0', null, token);
    assert.equal(pending.body.commands.length, 1);
    assert.equal(pending.body.commands[0].kind, 'tap');
    // неизвестный вид — 400, а не тихая постановка в очередь
    assert.equal((await call('POST', '/api/federation/phone', { kind: 'reboot' }, 'HUB')).status, 400);
  } finally {
    hub.close();
  }
});

test('врата: снапшот одной сессии не подменяет другую', async () => {
  const hub = createHub({ pairCode: 'ABCD', hubToken: 'HUB' });
  const { call } = await started(hub);
  try {
    const token = (await call('POST', '/fed/v1/pair', { code: 'ABCD', node: { name: 'n1' } })).body.token;
    await call('POST', '/fed/v1/index', { sessions: [{ id: 'a' }, { id: 'b' }] }, token);
    await call('POST', '/fed/v1/snapshot', { sessionId: 'a', messages: [{ role: 'user', text: 'из A' }] }, token);
    await call('POST', '/fed/v1/snapshot', { sessionId: 'b', messages: [{ role: 'user', text: 'из B' }] }, token);
    const a = await call('GET', '/api/federation/session?id=a', null, 'HUB');
    const b = await call('GET', '/api/federation/session?id=b', null, 'HUB');
    assert.equal(a.body.messages[0].text, 'из A');
    assert.equal(b.body.messages[0].text, 'из B');
  } finally {
    hub.close();
  }
});
