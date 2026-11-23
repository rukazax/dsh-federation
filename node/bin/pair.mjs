#!/usr/bin/env node
// Спаривание узла с хабом: одноразовый код → постоянный токен узла.
//   node bin/pair.mjs --hub http://192.168.88.35:18990 --code ABCD --name debian17
//   node bin/pair.mjs --status
// Токен кладётся в $DSH_HOME/federation/node.json (0600) и больше никуда не уходит:
// на хабе хранится только sha256.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DIR = path.join(HOME, 'federation');
const FILE = path.join(DIR, 'node.json');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

if (process.argv.includes('--status')) {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    console.log(`${j.hub} · nodeId=${j.nodeId} · name=${j.name} · paired_at=${j.paired_at}`);
  } catch {
    console.log(`не спарен: ${FILE} нет`);
    process.exit(1);
  }
  process.exit(0);
}

const hub = (arg('hub', '') || '').replace(/\/$/, '');
const code = arg('code', '');
const name = arg('name', os.hostname());
if (!hub || !code) {
  console.error('нужно: --hub <url> --code <код спаривания> [--name <имя>]');
  process.exit(2);
}

const res = await fetch(`${hub}/fed/v1/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, node: { name, version: process.env.DSH_VERSION || null, os: `${os.platform()}-${os.release()}`, host: os.hostname() } })
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.ok) {
  console.error(`спаривание не удалось: ${res.status} ${JSON.stringify(body)}`);
  process.exit(1);
}

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ hub, nodeId: body.nodeId, token: body.token, name, paired_at: new Date().toISOString() }, null, 1), { mode: 0o600 });
console.log(`спарено: nodeId=${body.nodeId} hub=${hub} файл=${FILE}`);
console.log('дальше: перечитать плагин узла (plugin_manager set_bundle @local/dsh-hub-node false→true) или перезапустить DSH');
