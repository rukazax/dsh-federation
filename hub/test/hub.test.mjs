// Проверка среза P0/P2: спаривание, hello, index, списки, отказ без токена, персистентность.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, overviewSvg, vaultOverview } from '../src/hub.mjs';

async function started(hub) {
  await new Promise((r) => hub.server.listen(0, '127.0.0.1', r));
  const port = hub.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };
  return { base, call };
}

test('спаривание, hello, index и выдача списков', async () => {
  const hub = createHub({ pairCode: 'ABCD', hubToken: 'HUB' });
  const { call } = await started(hub);
  try {
    const bad = await call('POST', '/fed/v1/pair', { code: 'NOPE', node: { name: 'node-a' } });
    assert.equal(bad.status, 401);

    const paired = await call('POST', '/fed/v1/pair', {
      code: 'ABCD',
      node: { name: 'node-a', version: '0.2.2-rc.5', os: 'linux' }
    });
    assert.equal(paired.status, 200);
    assert.match(paired.body.token, /^[0-9a-f]{48}$/);
    const token = paired.body.token;

    const hello = await call('POST', '/fed/v1/hello', { proto: 1, capabilities: { exec: true }, models_seen: ['a/b'] }, token);
    assert.equal(hello.status, 200);
    assert.deepEqual(hello.body.allowlist, []);

    const wrongProto = await call('POST', '/fed/v1/hello', { proto: 2 }, token);
    assert.equal(wrongProto.status, 400);

    const index = await call('POST', '/fed/v1/index', {
      sessions: [
        { id: 's1', title: 'первая', cwd: '/tmp', status: 'idle', updated_at: '2026-11-23T20:00:00Z', turns: 3, size: 1200 },
        { id: 's2', title: 'вторая', updated_at: '2026-11-23T21:00:00Z' }
      ]
    }, token);
    assert.equal(index.status, 200);
    assert.equal(index.body.upserted, 2);

    // повторный index с другой формой той же сессии не плодит дубли
    await call('POST', '/fed/v1/index', { sessions: [{ id: 's1', title: 'первая (правка)' }] }, token);

    const unauth = await call('GET', '/api/federation/sessions');
    assert.equal(unauth.status, 401);

    const sessions = await call('GET', '/api/federation/sessions', null, 'HUB');
    assert.equal(sessions.body.sessions.length, 2);
    assert.equal(sessions.body.sessions.find((s) => s.id === 's1').title, 'первая (правка)');

    const nodes = await call('GET', '/api/federation/nodes', null, 'HUB');
    assert.equal(nodes.body.nodes.length, 1);
    assert.equal(nodes.body.nodes[0].name, 'node-a');
    assert.deepEqual(nodes.body.nodes[0].models_seen, ['a/b']);
  } finally {
    hub.close();
  }
});

test('данные узла переживают перезапуск хаба', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-'));
  const dbPath = join(dir, 'fed.sqlite');
  try {
    const first = createHub({ dbPath, pairCode: 'CODE' });
    const a = await started(first);
    const paired = await a.call('POST', '/fed/v1/pair', { code: 'CODE', node: { name: 'node-p' } });
    await a.call('POST', '/fed/v1/index', { sessions: [{ id: 'x', title: 't' }] }, paired.body.token);
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    const second = createHub({ dbPath, hubToken: 'HUB' });
    const b = await started(second);
    try {
      const nodes = await b.call('GET', '/api/federation/nodes', null, 'HUB');
      assert.equal(nodes.body.nodes.length, 1);
      const sessions = await b.call('GET', '/api/federation/sessions', null, 'HUB');
      assert.equal(sessions.body.sessions.length, 1);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('обзор базы Obsidian: счётчики по разделам и последний обзор «Аналитика»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'));
  const vault = join(dir, 'vault');
  try {
    mkdirSync(join(vault, 'Facts'), { recursive: true });
    mkdirSync(join(vault, 'Tasks'), { recursive: true });
    mkdirSync(join(vault, 'Аналитика'), { recursive: true });
    writeFileSync(join(vault, 'Memory Hub.md'), '# Memory Hub\n');
    writeFileSync(join(vault, 'Facts', 'a.md'), '- факт\n');
    writeFileSync(join(vault, 'Facts', 'b.md'), '- факт\n');
    writeFileSync(join(vault, 'Tasks', 't.md'), '- [ ] задача\n');
    writeFileSync(join(vault, 'Аналитика', 'analysis-2026-11-20.md'), 'старый обзор\n');
    writeFileSync(join(vault, 'Аналитика', 'analysis-2026-11-23.md'), '# Обзор\n\n- цель: федерация\n');

    const hub = createHub({ hubToken: 'HUB', vaultPath: vault });
    const { call } = await started(hub);
    try {
      assert.equal((await call('GET', '/api/federation/memory/overview')).status, 401);

      const res = await call('GET', '/api/federation/memory/overview', null, 'HUB');
      assert.equal(res.status, 200);
      assert.equal(res.body.available, true);
      assert.equal(res.body.notes.total, 6);
      assert.equal(res.body.notes.bySection.Facts, 2);
      assert.equal(res.body.notes.bySection['(root)'], 1);
      assert.equal(res.body.analysis.name, 'analysis-2026-11-23.md');
      assert.match(res.body.analysis.excerpt, /цель: федерация/);
    } finally {
      hub.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('пропавшая папка vault: available=false, а не 500', async () => {
  const hub = createHub({ vaultPath: '/nonexistent/vault-for-test' });
  const { call } = await started(hub);
  try {
    const res = await call('GET', '/api/federation/memory/overview');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
    assert.equal(res.body.reason, 'vault-missing');
    assert.equal(res.body.notes.total, 0);
    assert.equal(vaultOverview('').available, false);
  } finally {
    hub.close();
  }
});

test('векторный обзор: SVG с живыми числами и экранированием', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vault-'));
  const vault = join(dir, 'vault');
  try {
    mkdirSync(join(vault, 'Facts'), { recursive: true });
    mkdirSync(join(vault, 'Аналитика'), { recursive: true });
    writeFileSync(join(vault, 'Memory Hub.md'), '# x\n');
    writeFileSync(join(vault, 'Facts', 'a.md'), '- a\n');
    writeFileSync(join(vault, 'Facts', 'b.md'), '- b\n');
    writeFileSync(join(vault, 'Facts', 'c.md'), '- c\n');
    writeFileSync(join(vault, 'Аналитика', 'analysis-2026-11-24.md'), '# Обзор\n\n- 3 факта\n');

    const hub = createHub({ hubToken: 'HUB', vaultPath: vault });
    const { base } = await started(hub);
    try {
      const res = await fetch(`${base}/api/federation/memory/overview?format=svg`, {
        headers: { authorization: 'Bearer HUB' }
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
      const svg = await res.text();
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match(svg, /Обзор базы Obsidian/);
      assert.match(svg, /Facts/);
      assert.match(svg, />5</); // 5 заметок всего: 3 факта + обзор + Memory Hub.md
      assert.match(svg, /analysis-2026-11-24\.md/);
    } finally {
      hub.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('векторный обзор: имена экранируются, пустая база — не падение', () => {
  const svg = overviewSvg({
    available: true,
    vault: '/v & <x>',
    notes: { total: 5, bySection: { 'a<b': 5 } },
    analysis: null,
    checked_at: '2026-11-23T19:05:51.339Z'
  });
  assert.ok(!svg.includes('<b>'), 'сырой тег из имени раздела не должен попасть в SVG');
  assert.match(svg, /a&lt;b/);
  assert.match(svg, /\/v &amp; &lt;x&gt;/);
  assert.match(svg, /обзора ещё нет/);

  const missing = overviewSvg({ available: false, reason: 'vault-missing', vault: null, notes: { total: 0, bySection: {} } });
  assert.match(missing, /vault-missing/);
  assert.match(missing, /нет доступа к vault/);
  assert.ok(missing.length > 200);
});

// ── P1/P3: команды узлу, снапшоты, usage, аудит ──────────────────────────────

/** Одно SSE-событие с data:-строкой; таймаут — чтобы тест падал, а не висел. */
async function readEvent(reader, ms = 3000) {
  let buf = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += Buffer.from(value).toString('utf8');
    const line = buf.split('\n').find((l) => l.startsWith('data: '));
    if (line) return JSON.parse(line.slice(6));
  }
  throw new Error('SSE event timeout');
}

test('команда уходит узлу по SSE, ответ идемпотентен, аудит пишется', async () => {
  const hub = createHub({ pairCode: 'CODE', hubToken: 'HUB' });
  const { base, call } = await started(hub);
  const paired = await call('POST', '/fed/v1/pair', { code: 'CODE', node: { name: 'n1' } });
  const { token, nodeId } = paired.body;
  const ac = new AbortController();
  try {
    const stream = await fetch(`${base}/fed/v1/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();

    const p = await call('POST', '/api/federation/prompt', { node: nodeId, sessionId: 's1', text: 'привет' }, 'HUB');
    assert.equal(p.status, 200);
    assert.match(p.body.commandId, /^[0-9a-f]{12}$/);

    const ev = await readEvent(reader);
    assert.equal(ev.kind, 'prompt');
    assert.equal(ev.commandId, p.body.commandId);
    assert.equal(ev.payload.text, 'привет');

    const rep = await call('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true, result: { accepted: true } }, token);
    assert.equal(rep.status, 200);
    assert.equal(rep.body.state, 'done');

    const dup = await call('POST', '/fed/v1/reply', { commandId: ev.commandId, ok: true }, token);
    assert.equal(dup.body.duplicate, true);

    const audit = await call('GET', '/api/federation/audit', null, 'HUB');
    assert.ok(audit.body.audit.some((a) => a.action === 'prompt' && a.result === 'queued'));

    const stats = await call('GET', '/api/federation/stats', null, 'HUB');
    assert.equal(stats.body.commands.find((c) => c.state === 'done').c, 1);
  } finally {
    ac.abort();
    hub.close();
  }
});

test('офлайн-команда ждёт и приходит по курсору при переподключении', async () => {
  const hub = createHub({ pairCode: 'CODE', hubToken: 'HUB' });
  const { base, call } = await started(hub);
  try {
    const paired = await call('POST', '/fed/v1/pair', { code: 'CODE', node: { name: 'n2' } });
    const { token, nodeId } = paired.body;
    // узел не на связи — команда лежит в очереди
    await call('POST', '/api/federation/prompt', { node: nodeId, sessionId: 's9', text: 'офлайн' }, 'HUB');

    const polling = await call('GET', '/fed/v1/commands?since=0', null, token);
    assert.equal(polling.body.commands.length, 1);
    assert.equal(polling.body.commands[0].payload.text, 'офлайн');

    const ac = new AbortController();
    const stream = await fetch(`${base}/fed/v1/stream?cursor=0`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    const ev = await readEvent(stream.body.getReader());
    ac.abort();
    assert.equal(ev.payload.text, 'офлайн');
  } finally {
    hub.close();
  }
});

test('снапшот и usage: переписка читается, токены не дублируются', async () => {
  const hub = createHub({ pairCode: 'CODE', hubToken: 'HUB' });
  const { call } = await started(hub);
  try {
    const paired = await call('POST', '/fed/v1/pair', { code: 'CODE', node: { name: 'n3' } });
    const { token, nodeId } = paired.body;
    await call('POST', '/fed/v1/index', { sessions: [{ id: 's1', title: 'книга', status: 'idle' }] }, token);

    const snap = await call('POST', '/fed/v1/snapshot', {
      sessionId: 's1',
      upToSeq: 42,
      messages: [
        { role: 'user', text: 'сколько заметок?' },
        { role: 'assistant', text: 'девять тысяч' }
      ]
    }, token);
    assert.equal(snap.body.messages, 2);

    const detail = await call('GET', `/api/federation/session?id=s1&node=${nodeId}`, null, 'HUB');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.title, 'книга');
    assert.equal(detail.body.up_to_seq, 42);
    assert.equal(detail.body.messages[1].text, 'девять тысяч');

    const u1 = await call('POST', '/fed/v1/usage', { calls: [
      { request_id: 'r1', provider: 'zai', model: 'glm-5.3-flash', in_tokens: 100, out_tokens: 20, cost_usd: '0.0012' },
      { request_id: 'r1', provider: 'zai', model: 'glm-5.3-flash', in_tokens: 100, out_tokens: 20 }
    ] }, token);
    assert.equal(u1.body.stored, 1);
    assert.equal(u1.body.skipped, 1);

    const stats = await call('GET', '/api/federation/stats', null, 'HUB');
    assert.equal(stats.body.usage.c, 1);
    assert.equal(stats.body.usage.i, 100);
    assert.equal(stats.body.by_model[0].model, 'glm-5.3-flash');
  } finally {
    hub.close();
  }
});
