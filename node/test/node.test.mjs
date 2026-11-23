// Проверка узла федерации: index с заголовком из проекции, prompt исполняется у себя,
// переписка уходит снапшотом, ответ на команду идемпотентен. Хаб подделан HTTP-сервером.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const waitFor = async (fn, ms = 6000, what = 'условие') => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`не дождались: ${what}`);
};

const json = (res, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
};

test('чистые части: текст сообщения, переписка, строка индекса', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-node-unit-'));
  const mod = await import('../index.js');
  assert.equal(mod.messageText([{ type: 'text', text: 'раз' }, { type: 'reasoning', text: 'нет' }, { type: 'text', text: 'два' }]), 'раз\nдва');
  assert.equal(mod.messageText(null), '');
  const msgs = mod.toMessages([
    { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'вопрос' }] } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'ответ' }] } } } },
    { type: 'event', event: { type: 'turn/start', seq: 3, time: 3, data: {} } }
  ]);
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['user', 'вопрос'], ['assistant', 'ответ']]);
  assert.equal(mod.toIndexRow({ sessionId: 's', updatedAt: 0, running: true }).id, 's');
  assert.equal(mod.toIndexRow({ sessionId: 's', projections: { values: { title: ' Книга ' } } }).title, 'Книга');
  assert.equal(mod.toIndexRow({ sessionId: 's' }).title, null);
});

test('узел отдаёт index, исполняет prompt у себя и присылает снапшот', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-node-'));
  const seen = { hello: null, index: null, replies: [], snapshots: [], prompts: [] };
  let stream = null;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/fed/v1/hello') {
      seen.hello = body;
      return json(res, { ok: true, nodeId: 'node_t', proto: 1, allowlist: [] });
    }
    if (url.pathname === '/fed/v1/index') {
      seen.index = body;
      return json(res, { ok: true, upserted: body.sessions.length });
    }
    if (url.pathname === '/fed/v1/reply') {
      seen.replies.push(body);
      return json(res, { ok: true, state: body.ok ? 'done' : 'failed' });
    }
    if (url.pathname === '/fed/v1/snapshot') {
      seen.snapshots.push(body);
      return json(res, { ok: true });
    }
    if (url.pathname === '/fed/v1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      stream = res;
      // команда приходит сразу после подписки — как из очереди хаба
      setTimeout(() => {
        res.write(`id: 1\ndata: ${JSON.stringify({ seq: 1, commandId: 'c1', kind: 'prompt', payload: { sessionId: 's1', text: 'из хаба' } })}\n\n`);
      }, 20);
      return;
    }
    json(res, { ok: false, error: 'not-found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hub = `http://127.0.0.1:${server.address().port}`;

  mkdirSync(join(home, 'federation'), { recursive: true });
  writeFileSync(join(home, 'federation', 'node.json'), JSON.stringify({ hub, nodeId: 'node_t', token: 'tok', name: 'test-node' }));
  process.env.DSH_HOME = home;

  const ctx = {
    logger: { info() {} },
    sessionController: {
      list: async () => ({
        items: [{ sessionId: 's1', updatedAt: 1_700_000_000_000, running: false, blank: false, cwd: '/w', projections: { kind: 'cached', asOfSeq: 1, values: { title: 'моя книга' } } }]
      }),
      page: async () => ({
        cursor: 2,
        hasMore: false,
        records: [
          { type: 'event', event: { type: 'user/message', seq: 1, time: 1_700_000_000_000, data: { message: { content: [{ type: 'text', text: 'привет' }] } } } },
          { type: 'event', event: { type: 'assistant/message', seq: 2, time: 1_700_000_001_000, data: { message: { content: [{ type: 'text', text: 'ответ' }] } } } }
        ]
      }),
      prompt: async (req) => {
        seen.prompts.push(req);
        return { accepted: true };
      },
      cancel: () => ({}),
      rename: async () => ({}),
      state: async () => ({ cursor: 2, active: false, running: false, queue: null, pendingInput: [] })
    }
  };

  const mod = await import(`../index.js?t=${Date.now()}`);
  try {
    mod.apply(ctx);
    await waitFor(() => seen.hello && seen.index, 6000, 'hello и index');
    assert.equal(seen.hello.proto, 1);
    assert.equal(seen.index.sessions[0].title, 'моя книга');
    assert.equal(seen.index.sessions[0].status, 'idle');

    await waitFor(() => seen.prompts.length === 1, 6000, 'prompt исполнен');
    assert.equal(seen.prompts[0].content[0].text, 'из хаба');
    assert.equal(seen.prompts[0].mode, 'queue');

    await waitFor(() => seen.replies.some((r) => r.commandId === 'c1' && r.ok), 4000, 'ответ на команду');
    await waitFor(() => seen.snapshots.length >= 1, 8000, 'снапшот после хода');
    assert.equal(seen.snapshots[0].sessionId, 's1');
    assert.equal(seen.snapshots[0].upToSeq, 2);
    assert.deepEqual(seen.snapshots[0].messages.map((m) => m.role), ['user', 'assistant']);
  } finally {
    mod.stopActiveNode();
    stream?.end();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
