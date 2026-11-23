// Проверка среза P0/P2: спаривание, hello, index, списки, отказ без токена, персистентность.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, vaultOverview } from '../src/hub.mjs';

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
