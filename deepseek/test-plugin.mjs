// Drives the DSH bundle with a stubbed Cordis context and the real keepawake.js in a temp state
// dir (no OS lock: KEEPAWAKE_BACKEND=none), so the whole event mapping is testable on any OS.
//
//   node deepseek/test-plugin.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { apply } from './lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'keepawake.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-dsh-'));
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

// Minimal Cordis context: `on` records listeners, and the plugin's returned cleanup is the
// disposer Cordis would run when the fiber unloads.
function makeCtx() {
  const listeners = new Map();
  const ctx = {
    logger: { warn: () => {} },
    on(name, callback) {
      const list = listeners.get(name) ?? [];
      list.push(callback);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        listeners.set(name, current.filter((entry) => entry !== callback));
      };
    },
  };
  const emit = (name, ...args) => {
    for (const callback of [...(listeners.get(name) ?? [])]) callback(...args);
  };
  return { ctx, emit };
}

const { ctx, emit } = makeCtx();
const cleanup = apply(ctx, {});

async function run() {
  // A running turn holds, a model step re-arms the same marker, and turn/end releases it.
  emit('agent/status', { status: 'running', agent: { id: 's1' } });
  assert.ok(await wait(() => held('s1')), 'agent/status running did not hold');
  emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
  emit('session/event', { id: 's1' }, { type: 'step/start', data: { turn: 1, step: 1 } });
  await sleep(400);
  assert.ok(held('s1'), 'a model step released the marker');
  emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.ok(await wait(() => !held('s1')), 'turn/end did not release');

  // A reloaded plugin re-arms on the next tool call mid-turn, without a running status edge.
  emit('session/event', { id: 's2' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } });
  assert.ok(await wait(() => held('s2')), 'tool/call did not re-arm a reloaded instance');
  assert.ok(await wait(() => {
    const mtime = fs.statSync(marker('s2')).mtimeMs;
    return Date.now() - mtime < 5000;
  }), 'tool/call did not refresh the marker');

  // Tool results refresh the marker so a long tool sequence never hits the stale ceiling.
  const mtime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(marker('s2'), mtime, mtime);
  emit('session/event', { id: 's2' }, { type: 'tool/result', data: { turn: 1, step: 1 } });
  assert.ok(await wait(() => Date.now() - fs.statSync(marker('s2')).mtimeMs < 5000), 'tool/result did not refresh the marker');
  emit('agent/status', { status: 'idle', agent: { id: 's2' } });
  assert.ok(await wait(() => !held('s2')), 'agent/status idle did not release');

  // A background job is covered by the turn marker until the turn ends; only a job that is still
  // running then gets a holder of its own.
  emit('agent/status', { status: 'running', agent: { id: 's3' } });
  emit('session/event', { id: 's3' }, { type: 'job/registered', data: { jobId: 'bash-abc123', kind: 'bash' } });
  assert.ok(!held('dsh-job-bash-abc123'), 'job/registered took a holder during the turn');
  emit('session/event', { id: 's3' }, { type: 'turn/end', data: { turn: 1 } });
  assert.ok(await wait(() => !held('s3')), 'turn/end did not release the session');
  assert.ok(await wait(() => held('dsh-job-bash-abc123')), 'turn/end did not hold a running job');
  emit('session/event', { id: 's3' }, { type: 'job/settled', data: { jobId: 'bash-abc123', status: 'completed' } });
  assert.ok(await wait(() => !held('dsh-job-bash-abc123')), 'job/settled did not release');

  // A job that settles inside the turn never takes a holder at all.
  emit('agent/status', { status: 'running', agent: { id: 's3b' } });
  emit('session/event', { id: 's3b' }, { type: 'job/registered', data: { jobId: 'bash-fast', kind: 'bash' } });
  emit('session/event', { id: 's3b' }, { type: 'job/settled', data: { jobId: 'bash-fast', status: 'completed' } });
  emit('session/event', { id: 's3b' }, { type: 'turn/end', data: { turn: 1 } });
  assert.ok(!held('dsh-job-bash-fast'), 'a job that settled inside the turn still got a holder');

  // A reloaded plugin that missed the turn edge holds a job registered later.
  emit('session/event', { id: 's7' }, { type: 'job/registered', data: { jobId: 'bash-late', kind: 'bash' } });
  assert.ok(await wait(() => held('dsh-job-bash-late')), 'a job registered without a turn marker did not hold');
  emit('session/event', { id: 's7' }, { type: 'job/settled', data: { jobId: 'bash-late', status: 'completed' } });
  assert.ok(await wait(() => !held('dsh-job-bash-late')), 'job/settled did not release the late job');

  // Disposing the agent or the session stops the holder outright.
  emit('agent/status', { status: 'running', agent: { id: 's4' } });
  assert.ok(await wait(() => held('s4')), 'agent/status running did not hold before disposal');
  emit('agent/disposed', { agent: { id: 's4' } });
  assert.ok(await wait(() => !held('s4')), 'agent/disposed did not stop');

  emit('session/event', { id: 's5' }, { type: 'turn/start', data: { turn: 1 } });
  assert.ok(await wait(() => held('s5')), 'turn/start did not hold before session disposal');
  emit('session/disposed', { id: 's5' });
  assert.ok(await wait(() => !held('s5')), 'session/disposed did not stop');

  // Unload clears its own markers without waiting for the grace.
  emit('agent/status', { status: 'running', agent: { id: 's6' } });
  assert.ok(await wait(() => held('s6')), 'agent/status running did not hold before unload');
  cleanup();
  assert.ok(await wait(() => !held('s6')), 'unload left the marker behind');

  // config.path wins over the package sibling: the copy gets its own state dir, so its marker
  // proves the copy ran rather than the checkout.
  const altDir = path.join(dir, 'alt');
  fs.mkdirSync(altDir);
  const alt = path.join(dir, 'keepawake-alt.js');
  // Drop the shebang: prepended, it would no longer be the first line and node would reject it.
  const src = fs.readFileSync(script, 'utf8').replace(/^#![^\n]*\n/, '');
  fs.writeFileSync(alt, `process.env.KEEPAWAKE_DIR = ${JSON.stringify(altDir)};\n` + src);
  const second = makeCtx();
  const cleanup2 = apply(second.ctx, { path: alt });
  second.emit('agent/status', { status: 'running', agent: { id: 'alt' } });
  assert.ok(await wait(() => fs.existsSync(path.join(altDir, 'alt.busy'))), 'config.path was ignored');
  assert.ok(!held('alt'), 'the package sibling ran instead of config.path');
  cleanup2();
  assert.ok(await wait(() => !fs.existsSync(path.join(altDir, 'alt.busy'))), 'config.path instance did not clean up');
}

try {
  await run();
  console.log('keepawake dsh: selftest ok');
} catch (e) {
  console.error('keepawake dsh: selftest FAILED:', e.message);
  process.exitCode = 1;
} finally {
  // Holders are detached; kill them before the temp dir goes away.
  for (const d of [dir, path.join(dir, 'alt')]) {
    try {
      for (const file of fs.readdirSync(d)) {
        if (!file.endsWith('.pid')) continue;
        try { process.kill(parseInt(fs.readFileSync(path.join(d, file), 'utf8'), 10)); } catch { /* gone */ }
      }
    } catch { /* the alt state dir may not exist */ }
  }
  await sleep(200);
  fs.rmSync(dir, { recursive: true, force: true });
}
