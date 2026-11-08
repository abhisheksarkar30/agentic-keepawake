// Drives the plugin with a stubbed OpenCode context and the real keepawake.js in a temp state
// dir (no OS lock: KEEPAWAKE_BACKEND=none), so the whole mapping is testable on any OS.
//
//   node opencode/selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import plugin from './index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-opencode-'));
process.env.KEEPAWAKE_DIR = dir;
process.env.KEEPAWAKE_BACKEND = 'none';
process.env.KEEPAWAKE_POLL_MS = '300';
process.env.KEEPAWAKE_GRACE_MS = '1500';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 10000) => {
  for (const start = Date.now(); Date.now() - start < ms; await sleep(100)) if (fn()) return true;
  return false;
};
const marker = (key) => path.join(dir, `${key}.busy`);
const held = (key) => fs.existsSync(marker(key));

const hooks = {};
const events = [];
const waits = [];
let wake;
const ctx = {
  options: {},
  session: {
    hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} }; },
    wait: ({ sessionID }) => new Promise((resolve) => waits.push({ sessionID, resolve: () => resolve(sessionID) })),
  },
  tool: { hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} }; } },
  event: {
    subscribe: () => (async function* () {
      for (;;) {
        if (events.length) { yield events.shift(); continue; }
        await new Promise((r) => { wake = r; });
      }
    })(),
  },
};
const push = (type, data, created = Date.now()) => { events.push({ type, created, data }); wake?.(); wake = undefined; };

async function run() {
  assert.strictEqual(plugin.id, 'agentic-keepawake');
  const cleanup = await plugin.setup(ctx);
  assert.deepStrictEqual(Object.keys(hooks).sort(), ['context', 'execute.after', 'execute.before', 'prompt']);

  // prompt admission holds; a model dispatch re-arms the same marker
  hooks.prompt({ sessionID: 's1' });
  assert.ok(await wait(() => held('s1')), 'prompt did not hold');
  hooks.context({ sessionID: 's1' });
  await sleep(400);
  assert.ok(held('s1'), 'a model dispatch released the marker');

  // the durable event-log tail is replayed on load: an old turn must not hold
  push('session.execution.started', { sessionID: 'old' }, Date.now() - 60000);
  await sleep(400);
  assert.ok(!held('old'), 'a replayed execution.start held the machine');

  // turn end releases
  push('session.execution.succeeded', { sessionID: 's1' });
  assert.ok(await wait(() => !held('s1')), 'execution.succeeded did not release');

  // background shells hold independently and survive the turn
  push('shell.created', { info: { id: 'sh_1' } });
  push('shell.created', { info: { id: 'sh_2' } });
  assert.ok(await wait(() => held('opencode-shell-sh_1')), 'shell.created did not hold');
  assert.ok(await wait(() => held('opencode-shell-sh_2')), 'second shell did not hold');
  push('shell.exited', { id: 'sh_1' });
  assert.ok(await wait(() => !held('opencode-shell-sh_1')), 'shell.exited did not release');
  assert.ok(held('opencode-shell-sh_2'), 'exiting one shell released another');
  push('shell.deleted', { id: 'sh_2' });
  assert.ok(await wait(() => !held('opencode-shell-sh_2')), 'shell.deleted did not release');

  // session.wait is a release path; an older wait must not release a newer turn
  push('session.execution.started', { sessionID: 's2' });
  assert.ok(await wait(() => held('s2')), 'execution.started did not hold');
  const stale = waits[waits.length - 1];
  push('session.execution.failed', { sessionID: 's2' });
  assert.ok(await wait(() => !held('s2')), 'execution.failed did not release');
  hooks.prompt({ sessionID: 's2' }); // new turn, no wait registered yet
  assert.ok(await wait(() => held('s2')), 'the new turn did not hold');
  stale.resolve();
  await sleep(600);
  assert.ok(held('s2'), 'a stale session.wait released the newer turn');
  const waitsBefore = waits.length;
  push('session.execution.started', { sessionID: 's2' });
  assert.ok(await wait(() => waits.length === waitsBefore + 1), 'the new turn did not register a wait');
  waits[waits.length - 1].resolve();
  assert.ok(await wait(() => !held('s2')), 'session.wait resolution did not release');

  // deletion stops the holder outright
  hooks.prompt({ sessionID: 's3' });
  assert.ok(await wait(() => held('s3')), 'prompt did not hold before deletion');
  push('session.deleted', { sessionID: 's3' });
  assert.ok(await wait(() => !held('s3')), 'session.deleted did not stop');

  // unload clears its own markers without waiting for the grace
  hooks.prompt({ sessionID: 's4' });
  assert.ok(await wait(() => held('s4')), 'prompt did not hold before unload');
  cleanup();
  assert.ok(await wait(() => !held('s4')), 'unload left the marker behind');

  // OpenCode 1 mapping
  const v1 = await plugin.server();
  await v1.event({ event: { type: 'session.status', properties: { sessionID: 'v1', status: { type: 'busy' } } } });
  assert.ok(await wait(() => held('v1')), 'v1 busy status did not hold');
  await v1.event({ event: { type: 'session.idle', properties: { sessionID: 'v1' } } });
  assert.ok(await wait(() => !held('v1')), 'v1 idle did not release');
}

try {
  await run();
  console.log('keepawake opencode: selftest ok');
} catch (e) {
  console.error('keepawake opencode: selftest FAILED:', e.message);
  process.exitCode = 1;
} finally {
  // Holders are detached; kill them before the temp dir goes away.
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.pid')) continue;
    try { process.kill(parseInt(fs.readFileSync(path.join(dir, file), 'utf8'), 10)); } catch { /* gone */ }
  }
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
}
