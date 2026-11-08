#!/usr/bin/env node
// Keep the machine awake while a Claude Code turn is in progress. Windows, macOS, Linux; no
// dependencies beyond node.
//
//   keepawake.js busy      UserPromptSubmit: set the busy marker, ensure one holder for the session
//   keepawake.js beat      Pre/PostToolUse(+Failure), async: refresh the marker's mtime if it exists
//   keepawake.js idle      Stop / StopFailure: clear the marker (the turn is done)
//   keepawake.js stop      SessionEnd: clear the marker and kill the holder
//   keepawake.js status    print each session's state, its holder, and whether keep-awake is paused
//   keepawake.js pause [m] stop holding the machine awake (for m minutes, else until `resume`)
//   keepawake.js resume    undo `pause`
//   keepawake.js hold <s>  internal: the detached holder for session <s>
//   keepawake.js runners   start the GitHub Actions runner watcher (detached, one per machine)
//   keepawake.js runners-watch   internal: the detached watcher body `runners` starts
//   keepawake.js install-runners / uninstall-runners   (Windows) start the watcher at every login
//   keepawake.js selftest  runnable check (touches nothing outside a temp dir; ~20s)
//
// One detached holder per session owns an OS sleep inhibitor and polls the marker file. It lets go
// when the marker is gone for GRACE_MS (turn finished), when the marker has not been refreshed for
// STALE_MS (turn presumed dead: Esc does not fire Stop, a crash fires nothing), or when you have
// been away past the cap. Display sleep is left alone. Mechanisms:
//   win32   a hidden powershell holding SetThreadExecutionState(ES_SYSTEM_REQUIRED)
//   darwin  caffeinate -i -w <holder pid>
//   linux   systemd-inhibit --what=sleep:idle ... cat
// KEEPAWAKE_BACKEND=none runs holders with no OS lock at all (CI on a runner that has no logind
// session, where systemd-inhibit is denied); everything else, including pause, behaves the same.
// Each is released by the OS if the holder dies (stdin pipe closes / -w target exits), so a killed
// holder cannot leave a stuck inhibitor.
//
// ponytail: the "away" cap uses real input-idle time where it can be read (win32 GetLastInputInfo,
// macOS HIDIdleTime, Linux xprintidle on X11). Where it cannot (Wayland without xprintidle) it falls
// back to wall-clock time since this busy period began, which also caps a legitimately long turn.
// ponytail: no Modern Standby tuning. If holding ES_SYSTEM_REQUIRED does not survive the display
// turning off on a given Windows laptop, the upgrade is PowerCreateRequest/ExecutionRequired.
// ponytail: a silent tool call longer than STALE_MS is released early. Raise STALE_MS if builds outlast it.
// ponytail: PermissionRequest/Notification do not refresh the marker; they mean waiting on you, not working.
// ponytail: Stop does not fire on Esc and background tasks can outlive Stop; both are bounded by STALE_MS / GRACE_MS.
//
// Runner watcher: a self-hosted GitHub Actions runner is "working" only while its Runner.Worker
// process exists (Runner.Listener just waits for jobs, so an idle runner holds nothing). One detached
// watcher per machine polls for it and holds the same OS lock, with the same AC/battery caps (measured
// from when the lock was taken, not from input idle: a job is meant to run while you are away) and the
// same grace between back-to-back jobs. On Windows it also looks inside the running WSL distro, where
// the Linux runners live; it never starts WSL just to look.
// ponytail: WSL is probed in the default distro only. Runners in another distro need `wsl -d <name>`.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const env = process.env;
// KEEPAWAKE_DIR/_POLL_MS/_STALE_MS/_GRACE_MS/_RUNNER_FILE are for selftest only; KEEPAWAKE_BACKEND
// is the documented CI/escape hatch. Nothing in hooks.json sets any of them.
const STATE_DIR = env.KEEPAWAKE_DIR || path.join(os.homedir(), '.claude', 'keepawake');
const POLL_MS = +env.KEEPAWAKE_POLL_MS || 30000;
const STALE_MS = +env.KEEPAWAKE_STALE_MS || 45 * 60000;
const GRACE_MS = env.KEEPAWAKE_GRACE_MS !== undefined ? +env.KEEPAWAKE_GRACE_MS : 5 * 60000;
const CAP_AC_MS = 6 * 3600000;
const CAP_BAT_MS = 3 * 3600000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const markerPath = (s) => path.join(STATE_DIR, s + '.busy');
const pidPath = (s) => path.join(STATE_DIR, s + '.pid');
const RUNNERS = 'runners'; // the watcher's "session" name; real session ids are uuids
const heldPath = () => path.join(STATE_DIR, RUNNERS + '.held'); // exists while the watcher holds the lock

// stdin is untrusted and the id becomes a filename. Absent id -> null: never share a marker.
function sessionId(payload) {
  const id = payload && payload.session_id;
  return id ? String(id).replace(/[^A-Za-z0-9_-]/g, '_') : null;
}

function readPayload() {
  if (process.stdin.isTTY) return {};
  try { return JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

function mtimeOf(p) { try { return fs.statSync(p).mtimeMs; } catch { return null; } }
function touch(p) { const n = new Date(); fs.utimesSync(p, n, n); }

// The whole release policy, pure so selftest can drive it. `mtime` is null when the marker is gone.
// Returns { release: 'done'|'stale'|'cap' } or { goneSince } (hold; carry goneSince to the next call).
function decide({ now, mtime, idleMs, capMs, goneSince }) {
  if (mtime == null) {
    const since = goneSince == null ? now : goneSince;
    return now - since >= GRACE_MS ? { release: 'done' } : { goneSince: since };
  }
  if (now - mtime >= STALE_MS) return { release: 'stale' };
  if (idleMs >= capMs) return { release: 'cap' };
  return {};
}

// One rule for an `ac` reading: 0 = battery, non-zero = mains, null = unknown. `last` is what a
// holder keeps on an unknown reading; with no last reading the caller passes its default (battery).
const acOn = (q, last) => (q == null ? last : q !== 0);

// ---------------------------------------------------------------- holder liveness
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// `stop`'s kill decision: the holder refreshes its pid file every poll, so a recycled PID whose file
// has gone quiet is never killed. (A spawner asks a different question -- see liveHolderPid.)
function holderPid(sess) {
  const pf = pidPath(sess);
  try {
    const pid = parseInt(fs.readFileSync(pf, 'utf8'), 10);
    const fresh = Date.now() - fs.statSync(pf).mtimeMs < 3 * POLL_MS + 5000;
    return pid > 0 && fresh && alive(pid) ? pid : 0;
  } catch { return 0; }
}
// Spawners and `status` ask a different question from `stop`'s kill decision: "does this session
// already have a holder?" A pid that is alive but whose file went quiet (the machine slept mid-turn)
// is still a holder, and spawning a second one (or reporting "no holder") is the hazard. Only `stop`
// needs the freshness check before it kills, and it clears the record only when this returns 0.
function liveHolderPid(sess) {
  const pf = pidPath(sess);
  try {
    const pid = parseInt(fs.readFileSync(pf, 'utf8'), 10);
    return pid > 0 && alive(pid) ? pid : 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------- pause / status
// One global flag file (not per session): its content is an expiry in epoch ms, or 0 for "until resume".
const pausePath = () => path.join(STATE_DIR, 'paused');
function isPaused() {
  try {
    const until = parseInt(fs.readFileSync(pausePath(), 'utf8'), 10) || 0;
    if (until && Date.now() >= until) { fs.rmSync(pausePath(), { force: true }); return false; }
    return true;
  } catch { return false; }
}
function cmdPause(minutes) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const m = Number(minutes);
  fs.writeFileSync(pausePath(), String(m > 0 ? Date.now() + m * 60000 : 0));
  console.log(m > 0 ? `keepawake: paused for ${m} min (holders release their lock within ${POLL_MS / 1000}s)`
    : 'keepawake: paused until `keepawake.js resume` (holders release their lock within ' + POLL_MS / 1000 + 's)');
}
function cmdResume() {
  const hadPause = fs.existsSync(pausePath());
  fs.rmSync(pausePath(), { force: true });
  // A holder that released while paused exits for good (cap/stale), so `resume` re-arms one for
  // every turn whose marker is still fresh -- but only if a pause was actually in effect: with none,
  // re-arming would resurrect a holder that released on the cap (README "Known limits"). The runner
  // watcher never exits on pause, so it needs nothing here.
  if (hadPause) {
    let markers = [];
    try { markers = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.busy')); } catch { /* no state dir yet */ }
    for (const f of markers) {
      const id = f.slice(0, -'.busy'.length);
      const mt = mtimeOf(markerPath(id));
      if (mt != null && Date.now() - mt < STALE_MS && !liveHolderPid(id)) cmdBusy(id);
    }
  }
  console.log('keepawake: resumed');
}

const ago = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
function statusLines() {
  const out = [isPaused() ? 'paused: yes (no sleep lock is held; `keepawake.js resume` to undo)' : 'paused: no'];
  let ids = [];
  try {
    ids = [...new Set(fs.readdirSync(STATE_DIR).filter((f) => /\.(busy|pid)$/.test(f)).map((f) => f.replace(/\.(busy|pid)$/, '')))];
  } catch { /* no state dir yet */ }
  if (!ids.length) out.push('no sessions');
  for (const id of ids) {
    const mt = mtimeOf(markerPath(id));
    const hp = liveHolderPid(id); // same predicate the spawn gates use: status and `busy` never disagree
    const holder = hp ? `holder pid ${hp}` : 'no holder';
    if (id === RUNNERS) {
      if (hp) out.push(`runner watcher: ${holder}, ${mtimeOf(heldPath()) != null ? 'holding the machine awake' : 'idle (not holding)'}`);
    } else if (mt != null) {
      const age = Date.now() - mt;
      out.push(age >= STALE_MS
        ? `${id}: stale marker (no activity for ${ago(age)}; the turn is presumed dead), ${holder}`
        : `${id}: turn running, last activity ${ago(age)} ago, ${holder}, stale release in ${ago(STALE_MS - age)}`);
    } else if (hp) {
      out.push(`${id}: turn finished, ${holder} (grace period, then releases)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- hook modes
function cmdBusy(sess) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const mf = markerPath(sess);
  if (fs.existsSync(mf)) touch(mf); else fs.writeFileSync(mf, '');
  if (liveHolderPid(sess)) return;
  const child = cp.spawn(process.execPath, [__filename, 'hold', sess], {
    detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  // A failed spawn emits 'error' (uncaught without a listener) and leaves child.pid undefined: write
  // no pid file then, so the next `busy` retries instead of recording "undefined" as a holder.
  child.on('error', () => {});
  child.unref();
  if (Number.isFinite(child.pid)) fs.writeFileSync(pidPath(sess), String(child.pid));
}

function cmdBeat(sess) {
  const mf = markerPath(sess);
  // Only an existing marker: a late async hook after Stop must not resurrect a busy session.
  if (fs.existsSync(mf)) { try { touch(mf); } catch { /* raced a delete */ } }
}

function cmdIdle(sess) { fs.rmSync(markerPath(sess), { force: true }); }

function cmdStop(sess) {
  cmdIdle(sess); // the holder would release anyway if the kill below loses the race
  const pid = holderPid(sess);
  if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  // Keep the record when a live holder we did not kill still owns it (the machine slept mid-turn, so
  // the file went stale): the next `stop` can kill it once it beats again. Nothing alive = no record.
  if (!liveHolderPid(sess)) fs.rmSync(pidPath(sess), { force: true });
}

// ---------------------------------------------------------------- backends
// start() -> { ask(q: 'idle'|'ac') -> Promise<number|null>, stop(), child }
//   idle: ms since last user input (null if unknown); ac: 0 on battery, non-zero = mains (every
//   backend emits 1), null = unknown. Unknown always means "keep the last reading"; with no last
//   reading yet (a holder's first ask) it means battery, the shorter and safer cap. Every consumer
//   uses this one rule (acOn).

const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace KA -Name N -MemberDefinition '
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);
[DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(byte[] b);
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(byte[] p);
[DllImport("kernel32.dll")] public static extern uint GetTickCount();
public static uint IdleMs() {
  byte[] b = new byte[8]; b[0] = 8;
  if (!GetLastInputInfo(b)) return uint.MaxValue;
  uint now = GetTickCount();
  uint idle = now - System.BitConverter.ToUInt32(b, 4);
  return idle > now ? 0 : idle;
}
public static int Ac() { byte[] b = new byte[12]; return GetSystemPowerStatus(b) ? b[0] : -1; }
'
if ([KA.N]::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }
'ready'
while (($l = [Console]::In.ReadLine()) -ne $null) {
  if ($l -eq 'idle') { [KA.N]::IdleMs() } elseif ($l -eq 'ac') { [KA.N]::Ac() }
}
`;

// A hidden powershell we talk to over stdin/stdout, one line per exchange: { child, next(ms), stop() }.
function psSession(script) {
  const child = cp.spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const lines = [];
  const waiters = [];
  let buf = '';
  let planned = false; // stop() was requested: the child exit is a reset, not a lost lock
  // A powershell that cannot start at all emits 'error'; without a listener that is an uncaught
  // exception instead of the notify path `next(15000)` drives.
  child.on('error', () => {});
  child.stdin.on('error', () => {}); // the ps process can die between polls; a write must not throw
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(l); else lines.push(l);
    }
  });
  const next = (ms) => new Promise((res) => {
    if (lines.length) return res(lines.shift());
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); res(null); }, ms);
    const w = (l) => { clearTimeout(t); res(l); };
    waiters.push(w);
  });
  const stop = () => { planned = true; try { child.stdin.end(); child.kill(); } catch { /* gone */ } };
  return { child, next, stop, planned: () => planned };
}

// One powershell reply -> a reading. A missing or empty reply means "unknown", never 0: for `ac`
// 0 reads as "on battery", for `idle` it would disable the cap (idleMs >= capMs never true). An `ac`
// reply outside {0,1} is unknown too: 255 is GetSystemPowerStatus' ACLineStatus "unknown" (-1 is a
// failed query), and neither may read as mains.
function winReading(l, q) {
  if (l == null || l === '') return null;
  const n = Number(l);
  if (Number.isNaN(n)) return null;
  if (q === 'idle') return n === 4294967295 ? null : n;
  return n === 0 || n === 1 ? n : null;
}

function winBackend(script = WIN_SCRIPT) {
  // `child` is a stable handle over the current ps session. A timed-out exchange discards that
  // session (its late reply would otherwise answer the next question), but the holder's
  // unexpected-exit listener must survive so a real death still notifies.
  const child = new (require('events').EventEmitter)();
  let cur = null;
  const open = async () => {
    const s = psSession(script);
    s.child.once('exit', () => { if (!s.planned() && s === cur) child.emit('exit'); });
    const l = await s.next(15000);
    if (l !== 'ready') { s.stop(); throw new Error('Windows refused the sleep request (or powershell could not start it)'); }
    cur = s;
  };
  return open().then(() => ({
    child,
    stop: () => { if (cur) cur.stop(); },
    async ask(q) {
      if (!cur) {
        try { await open(); } catch { child.emit('exit'); return null; } // the lock really is gone
      }
      const s = cur;
      s.child.stdin.write(q + '\n');
      const l = await s.next(5000);
      if (l == null) { s.stop(); if (cur === s) cur = null; } // timed out: drop the skewed queue
      return winReading(l, q);
    },
  }));
}

function spawnedBackend(cmd, args, ask) {
  const child = cp.spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let failed = null;
  let err = '';
  child.once('error', (e) => { failed = e; });
  child.stdin.on('error', () => {}); // the inhibitor can die between polls; stop()'s write must not throw
  child.stderr.on('data', (d) => { err += d; });
  // An inhibitor that dies at once (missing binary, polkit denial) must read as a failure.
  return sleep(1000).then(() => {
    if (failed || child.exitCode !== null) {
      throw new Error(`${cmd} could not hold a sleep lock: ${(failed && failed.code) || err.trim() || 'exit ' + child.exitCode}`);
    }
    return { child, ask: async (q) => ask(q), stop: () => { try { child.stdin.end(); child.kill(); } catch { /* gone */ } } };
  });
}

function execOut(cmd, args) {
  try { return cp.execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

function macAsk(q) {
  if (q === 'idle') {
    const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(execOut('ioreg', ['-c', 'IOHIDSystem', '-d', '4']) || '');
    return m ? Math.round(Number(m[1]) / 1e6) : null; // nanoseconds
  }
  const batt = execOut('pmset', ['-g', 'batt']);
  if (batt == null) return null; // the query failed: unknown, not mains
  return /Battery Power/.test(batt) ? 0 : 1;
}

function linuxAsk(q, d = '/sys/class/power_supply') { // d: selftest fixture seam
  if (q === 'idle') {
    const n = parseInt(execOut('xprintidle', []) || '', 10);
    return Number.isNaN(n) ? null : n;
  }
  try {
    let adapter = false;
    let battery = false;
    for (const n of fs.readdirSync(d)) {
      const t = fs.readFileSync(`${d}/${n}/type`, 'utf8').trim();
      if (t === 'Battery') { battery = true; continue; }
      if (t === 'UPS') continue;
      // Any other supply (Mains, USB/Type-C, wireless) is a charger whose `online` is authoritative.
      adapter = true;
      if (fs.readFileSync(`${d}/${n}/online`, 'utf8').trim() === '1') return 1;
    }
    // No battery at all is a desktop, always on mains. With a battery: an offline charger means the
    // laptop is on battery; a battery we cannot tie to any adapter (some USB-C chargers expose no
    // supply of their own) is unknown, never mains.
    if (!battery) return 1;
    return adapter ? 0 : null;
  } catch { return null; } // /sys (or a supply entry) unreadable: unknown, not mains
}

function startBackend() {
  if (env.KEEPAWAKE_BACKEND === 'none') {
    const child = new (require('events').EventEmitter)();
    return Promise.resolve({ child, stop() {}, ask: async (q) => (q === 'idle' ? null : 1) });
  }
  if (process.platform === 'win32') return winBackend();
  if (process.platform === 'darwin') return spawnedBackend('caffeinate', ['-i', '-w', String(process.pid)], macAsk);
  if (process.platform === 'linux') {
    return spawnedBackend('systemd-inhibit', ['--what=sleep:idle', '--who=claude-keepawake',
      '--why=Claude Code turn in progress', '--mode=block', 'cat'], linuxAsk);
  }
  return Promise.reject(new Error(`unsupported platform: ${process.platform}`));
}

// ---------------------------------------------------------------- notifications (best effort)
const WIN_TOAST = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$t = [System.Security.SecurityElement]::Escape($env:KA_TITLE); $b = [System.Security.SecurityElement]::Escape($env:KA_TEXT)
$x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

// Resolves when the notifier has exited (or 8s), so a holder about to exit does not cut it off.
function notify(title, text) {
  return new Promise((resolve) => {
    let cmd, args;
    const e = { ...env, KA_TITLE: title, KA_TEXT: text };
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_TOAST, 'utf16le').toString('base64')];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', 'display notification (system attribute "KA_TEXT") with title (system attribute "KA_TITLE")'];
    } else {
      cmd = 'notify-send';
      args = [title, text];
    }
    try {
      const c = cp.spawn(cmd, args, { stdio: 'ignore', windowsHide: true, env: e });
      c.once('error', resolve);
      c.once('exit', resolve);
      setTimeout(resolve, 8000).unref();
    } catch { resolve(); }
  });
}

// ---------------------------------------------------------------- the holder
const mins = (ms) => Math.round(ms / 60000);

async function hold(sess) {
  const mf = markerPath(sess);
  const pf = pidPath(sess);
  const beat = () => { try { touch(pf); } catch { /* pid file not written yet, or removed by stop */ } };
  beat();

  // The backend is acquired and dropped as `pause` / `resume` come and go; `be` is null while paused.
  let be = null;
  const acquire = async () => {
    try { be = await startBackend(); } catch (e) {
      await notify('Keep-awake failed', `${e.message}. This session will not hold the machine awake.`);
      fs.rmSync(pf, { force: true }); // no holder left behind: the pid file must not outlive this process
      process.exit(1);
    }
    beat(); // starting the backend can take seconds; keep the pid file fresh for holderPid()
    const mine = be;
    be.child.once('exit', async () => {
      if (mine.dropped) return;
      await notify('Keep-awake lost', 'The sleep lock process exited unexpectedly; sleep is allowed again.');
      fs.rmSync(pf, { force: true }); // same: this process is leaving
      process.exit(1);
    });
  };
  const drop = () => { if (be) { be.dropped = true; be.stop(); be = null; } };
  // While paused there is no backend to ask: ac keeps its last value and idle falls back to wall clock.
  const ask = async (q) => (be ? be.ask(q) : null);
  const capMs = (ac) => (ac ? CAP_AC_MS : CAP_BAT_MS);

  if (!isPaused()) await acquire();
  let ac = acOn(await ask('ac'), false); // no reading yet: assume battery (the 3h cap)
  let goneSince;
  let busySince = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    beat();

    if (isPaused()) drop(); else if (!be) await acquire();

    const q = await ask('ac');
    const nowAc = acOn(q, ac);
    if (nowAc !== ac) {
      ac = nowAc;
      const idle = (await ask('idle')) ?? Date.now() - busySince;
      const left = Math.max(0, mins(capMs(ac) - idle));
      notify('Keep-awake limit changed', `${ac ? 'Plugged in' : 'On battery'} -- keep-awake now allows ${capMs(ac) / 3600000}h without input; about ${left} min left before the machine may sleep.`);
    }

    const now = Date.now();
    const mtime = mtimeOf(mf);
    if (mtime != null && goneSince != null) busySince = now; // a new turn began inside the grace
    const idleMs = (await ask('idle')) ?? now - busySince;
    const r = decide({ now, mtime, idleMs, capMs: capMs(ac), goneSince });
    goneSince = r.goneSince;
    if (!r.release) continue;

    drop();
    // Only an early release changes when the machine may sleep under work you did not know was cut off.
    if (r.release === 'stale') await notify('Keep-awake released', `No Claude activity for ${mins(STALE_MS)} min -- the turn looks stuck or was interrupted. Sleep is allowed again.`);
    if (r.release === 'cap') await notify('Keep-awake released', `No input for ${capMs(ac) / 3600000}h (${ac ? 'AC' : 'battery'} limit). Claude may still be working, but the machine can now sleep.`);
    fs.rmSync(pf, { force: true });
    process.exit(0);
  }
}

// ---------------------------------------------------------------- runner watcher
// True while any runner on this machine is executing a job. KEEPAWAKE_RUNNER_FILE (selftest only)
// stands in for the process: a job is "running" while that file exists.
//
// Windows: the watcher is detached, so it has no console, and every console program it ran itself
// (tasklist, wsl) would allocate a fresh one and flash a terminal window each poll. Instead one
// long-lived hidden powershell does the probing: its children inherit that hidden console.
// `wsl -l --running -q` prints UTF-16 distro names, one per line (none running: a sentence with
// spaces). Only a distro that is already up is asked: `wsl -e` would otherwise boot the VM.
const PROBE_SCRIPT = `
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $j = [bool](Get-Process -Name Runner.Worker -ErrorAction SilentlyContinue)
  if (-not $j) {
    $up = (& wsl.exe -l --running -q 2>$null | Out-String) -replace "\`0", ''
    if ($up -match '(?m)^\\S+\\s*$') { & wsl.exe -e pgrep -x Runner.Worker *> $null; $j = ($LASTEXITCODE -eq 0) }
  }
  if ($j) { 1 } else { 0 }
}
`;
let probe = null;
async function runnerJobs() {
  if (env.KEEPAWAKE_RUNNER_FILE) return fs.existsSync(env.KEEPAWAKE_RUNNER_FILE);
  if (process.platform !== 'win32') {
    try { cp.execFileSync('pgrep', ['-x', 'Runner.Worker'], { stdio: 'ignore', timeout: 8000 }); return true; } catch { return false; }
  }
  try {
    if (!probe) { probe = psSession(PROBE_SCRIPT); const mine = probe; mine.child.once('exit', () => { if (probe === mine) probe = null; }); }
    probe.child.stdin.write('?\n');
    const r = await probe.next(20000);
    if (r == null) { probe.stop(); probe = null; } // a late answer would be read as the next poll's
    return r === '1';
  } catch { probe = null; return false; }
}

async function watchRunners() {
  const pf = pidPath(RUNNERS);
  const hf = heldPath();
  fs.rmSync(hf, { force: true });
  let be = null;
  let held; // when the lock was taken
  let goneSince;
  let capped = false; // gave up (cap hit or lock refused): re-arm only once the runners go quiet
  let ac = false; // last known mains state; a null (unknown) reading keeps it
  const drop = () => { if (be) { be.dropped = true; be.stop(); be = null; } fs.rmSync(hf, { force: true }); };
  for (;;) {
    try { touch(pf); } catch { /* pid file not written yet */ }
    const jobs = await runnerJobs();
    const now = Date.now();
    if (!jobs) capped = false;
    if (isPaused() || capped) { drop(); held = goneSince = undefined; } else if (jobs || be) { // be set = in the grace
      if (!be) {
        try {
          be = await startBackend();
          const mine = be;
          be.child.once('exit', () => { if (!mine.dropped) { be = null; fs.rmSync(hf, { force: true }); } }); // re-taken next poll
          held = Date.now();
          fs.writeFileSync(hf, '');
        } catch (e) {
          capped = true;
          await notify('Keep-awake failed', `${e.message}. Runner jobs will not hold the machine awake.`);
        }
      }
      if (be) {
        const q = await be.ask('ac');
        ac = acOn(q, ac); // unknown keeps the last reading, as the holder does
        const capMs = ac ? CAP_AC_MS : CAP_BAT_MS;
        const r = decide({ now, mtime: jobs ? now : null, idleMs: now - held, capMs, goneSince });
        goneSince = r.goneSince;
        if (r.release) {
          drop();
          held = undefined;
          if (r.release === 'cap') {
            capped = true;
            await notify('Keep-awake released', `Runner jobs have held the machine awake for ${capMs / 3600000}h (${ac ? 'AC' : 'battery'} limit). A job may still be running, but the machine can now sleep.`);
          }
        }
      }
    }
    await sleep(POLL_MS);
  }
}

function cmdRunners() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pid = liveHolderPid(RUNNERS);
  if (pid) return console.log(`keepawake: runner watcher already running (pid ${pid})`);
  const child = cp.spawn(process.execPath, [__filename, 'runners-watch'], { detached: true, stdio: 'ignore', windowsHide: true, env });
  // Same guard as cmdBusy: a failed spawn must not write "undefined" nor report the watcher started.
  child.on('error', (e) => console.error(`keepawake: could not start the runner watcher: ${e.message}`));
  child.unref();
  if (!Number.isFinite(child.pid)) { process.exitCode = 1; return; }
  fs.writeFileSync(pidPath(RUNNERS), String(child.pid));
  console.log(`keepawake: runner watcher started (pid ${child.pid})`);
}

// Windows: a hidden .vbs in the user's Startup folder (no admin needed, unlike a logon scheduled task).
// It pins the paths of this copy of the script, so re-run install-runners after a plugin update.
const startupVbs = () => path.join(env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'agentic-keepawake-runners.vbs');
function cmdInstallRunners() {
  if (process.platform !== 'win32') {
    console.error('install-runners is Windows only. Elsewhere, run `node keepawake.js runners` from a systemd user unit or launchd agent.');
    process.exit(1);
  }
  fs.writeFileSync(startupVbs(), `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${__filename}"" runners", 0, False\r\n`);
  console.log(`keepawake: will start the runner watcher at login (${startupVbs()})`);
  cmdRunners();
}
function cmdUninstallRunners() {
  fs.rmSync(startupVbs(), { force: true });
  const pid = holderPid(RUNNERS);
  if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  // Same rule as cmdStop: a quiet-but-live watcher was not killed, so its record (and hold marker)
  // must survive for the next poll; `status` still has to describe it truthfully.
  if (!liveHolderPid(RUNNERS)) {
    fs.rmSync(pidPath(RUNNERS), { force: true });
    fs.rmSync(heldPath(), { force: true });
  }
  console.log('keepawake: runner watcher stopped and removed from login');
}

// ---------------------------------------------------------------- selftest
async function selftest() {
  const assert = require('assert');
  const T = Date.now();
  const base = { now: T, idleMs: 0, capMs: CAP_AC_MS };

  // decide(): the whole policy
  assert.deepStrictEqual(decide({ ...base, mtime: T }), {}, 'fresh marker holds');
  assert.deepStrictEqual(decide({ ...base, mtime: T - STALE_MS - 1 }), { release: 'stale' });
  assert.deepStrictEqual(decide({ ...base, mtime: T, idleMs: CAP_AC_MS }), { release: 'cap' });
  assert.deepStrictEqual(decide({ ...base, mtime: null }), { goneSince: T }, 'gone starts the grace');
  assert.deepStrictEqual(decide({ ...base, mtime: null, goneSince: T - GRACE_MS + 1000 }), { goneSince: T - GRACE_MS + 1000 }, 'inside grace holds');
  assert.deepStrictEqual(decide({ ...base, mtime: null, goneSince: T - GRACE_MS }), { release: 'done' }, 'grace over releases');
  assert.deepStrictEqual(decide({ ...base, mtime: T, goneSince: T - 1000 }), {}, 'returning marker resets the grace');
  assert.strictEqual(decide({ ...base, mtime: T - STALE_MS - 1, goneSince: T }).release, 'stale', 'stale gets no grace');

  assert.strictEqual(sessionId({ session_id: 'a/b..c' }), 'a_b__c');
  assert.strictEqual(sessionId({}), null);

  // a missing/empty powershell reply is "unknown", never a reading of 0 (0 = on battery / idle 0)
  assert.strictEqual(winReading(null, 'idle'), null);
  assert.strictEqual(winReading('', 'ac'), null);
  assert.strictEqual(winReading('0', 'ac'), 0);
  assert.strictEqual(winReading('0', 'idle'), 0);
  assert.strictEqual(winReading('4294967295', 'idle'), null);
  assert.strictEqual(winReading('nope', 'idle'), null);
  // an `ac` reply that is not a power state (255 = ACLineStatus unknown, -1 = the query failed) is
  // "unknown", never mains, and one rule maps unknown to the last reading (battery when there is none)
  assert.strictEqual(winReading('1', 'ac'), 1);
  assert.strictEqual(winReading('255', 'ac'), null);
  assert.strictEqual(winReading('-1', 'ac'), null);
  assert.strictEqual(winReading('2', 'ac'), null);
  assert.strictEqual(acOn(null, false), false, 'unknown with no last reading assumes battery');
  assert.strictEqual(acOn(null, true), true, 'unknown keeps the last reading');
  assert.strictEqual(acOn(0, true), false);
  assert.strictEqual(acOn(1, false), true);

  // backend smoke: can hold, and the readings are sane
  const be = await startBackend();
  try {
    const idle = await be.ask('idle');
    assert.ok(idle === null || (idle >= 0 && idle <= os.uptime() * 1000 + 5000), `idle reading out of range: ${idle}`);
    assert.ok([null, 0, 1].includes(await be.ask('ac')), 'ac reading out of range');
  } finally { be.stop(); }

  // Linux power-supply classification: a battery with a USB-C charger is a laptop on battery, not a
  // desktop, and a battery whose adapter state cannot be read is unknown rather than mains.
  const ps = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-selftest-ps-'));
  try {
    const supply = (name, type, online) => {
      fs.mkdirSync(path.join(ps, name), { recursive: true });
      fs.writeFileSync(path.join(ps, name, 'type'), type + '\n');
      if (online != null) fs.writeFileSync(path.join(ps, name, 'online'), online + '\n');
    };
    assert.strictEqual(linuxAsk('ac', ps), 1, 'no battery at all must read as a desktop');
    assert.strictEqual(linuxAsk('ac', path.join(ps, 'missing')), null, 'an unreadable supply set must be unknown');
    supply('USB0', 'USB', 0);
    assert.strictEqual(linuxAsk('ac', ps), 1, 'no battery at all is a desktop even with an offline supply');
    supply('BAT0', 'Battery');
    assert.strictEqual(linuxAsk('ac', ps), 0, 'a battery plus an offline USB-C charger must be on battery');
    fs.rmSync(path.join(ps, 'USB0'), { recursive: true, force: true });
    assert.strictEqual(linuxAsk('ac', ps), null, 'a battery with no adapter state must be unknown');
    supply('USB0', 'USB', 1);
    assert.strictEqual(linuxAsk('ac', ps), 1, 'a battery plus an online charger must be on mains');
  } finally { fs.rmSync(ps, { recursive: true, force: true }); }

  // A timed-out exchange must not let its late reply answer the next question: the powershell
  // session is dropped (a planned reset, not a lost lock) and the next ask starts a fresh one.
  if (process.platform === 'win32') {
    const gate = path.join(os.tmpdir(), `ka-selftest-gate-${process.pid}`);
    fs.writeFileSync(gate, '');
    process.env.KA_SELFTEST_GATE = gate;
    const slow = `
'ready'
while (($l = [Console]::In.ReadLine()) -ne $null) {
  if ($l -eq 'idle') { if (Test-Path $env:KA_SELFTEST_GATE) { Start-Sleep -Seconds 6 }; if (Test-Path $env:KA_SELFTEST_GATE) { 1111 } else { 2222 } }
}
`;
    const sb = await winBackend(slow);
    try {
      assert.strictEqual(await sb.ask('idle'), null, 'a timed-out reading must be unknown');
      fs.rmSync(gate, { force: true });
      assert.strictEqual(await sb.ask('idle'), 2222, 'the timed-out session answered the next question');
    } finally { sb.stop(); delete process.env.KA_SELFTEST_GATE; fs.rmSync(gate, { force: true }); }
  }

  // end to end in a temp dir, on short timers
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-selftest-'));
  const e2 = { ...env, KEEPAWAKE_DIR: dir, KEEPAWAKE_POLL_MS: '300', KEEPAWAKE_GRACE_MS: '2500', KEEPAWAKE_STALE_MS: '3600000' };
  const run = (mode, id) => cp.spawnSync(process.execPath, [__filename, mode], { env: e2, input: JSON.stringify({ session_id: id }), timeout: 15000 });
  const S = 'selftest';
  const pidOf = () => parseInt(fs.readFileSync(path.join(dir, S + '.pid'), 'utf8'), 10);
  const rpidOf = () => parseInt(fs.readFileSync(path.join(dir, RUNNERS + '.pid'), 'utf8'), 10);
  try {
    run('beat', S);
    assert.ok(!fs.existsSync(path.join(dir, S + '.busy')), 'beat created a marker');

    run('busy', S);
    let pid = pidOf();
    await sleep(2500); // let the holder get its inhibitor
    assert.ok(alive(pid), 'holder not running after busy');
    const mf = path.join(dir, S + '.busy');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(mf, old, old);
    run('beat', S);
    assert.ok(Date.now() - mtimeOf(mf) < 3000, 'beat did not refresh the marker');

    run('busy', S);
    assert.strictEqual(pidOf(), pid, 'second busy started a second holder');

    // status / pause / resume
    const out = (m, ...a) => cp.spawnSync(process.execPath, [__filename, m, ...a], { env: e2, encoding: 'utf8', timeout: 15000 }).stdout;
    assert.match(out('status'), /selftest: turn running.*holder pid \d+/, 'status misses the running session');
    assert.match(out('status'), /paused: no/);
    out('pause');
    assert.match(out('status'), /paused: yes/);
    await sleep(1000);
    assert.ok(alive(pid), 'holder died while paused');
    // A holder that released on the cap/stale exits for good; `resume` must re-arm one for a turn
    // that is still running (README: a released holder is re-armed by `resume`, or the next prompt).
    try { process.kill(pid); } catch { /* gone */ }
    fs.rmSync(path.join(dir, S + '.pid'), { force: true });
    assert.match(out('status'), /selftest: turn running.*no holder/, 'a released holder is still reported');
    out('resume');
    assert.match(out('status'), /paused: no/);
    await sleep(800);
    assert.ok(fs.existsSync(path.join(dir, S + '.pid')), 'resume did not re-arm a holder for the running turn');
    assert.notStrictEqual(pidOf(), pid, 'resume did not start a new holder');
    pid = pidOf();
    assert.ok(alive(pid), 'the holder resume re-armed is not running');
    assert.match(out('status'), /selftest: turn running.*holder pid \d+/, 'resume left the turn without a holder');
    fs.writeFileSync(path.join(dir, 'paused'), String(Date.now() - 1000));
    assert.match(out('status'), /paused: no/, 'an expired pause still reads as paused');
    assert.ok(!fs.existsSync(path.join(dir, 'paused')), 'expired pause file not cleaned up');

    // `resume` re-arms only when a pause was in effect: with none it must not resurrect a holder
    // that released on the cap (README "Known limits").
    try { process.kill(pid); } catch { /* gone */ }
    fs.rmSync(path.join(dir, S + '.pid'), { force: true });
    assert.match(out('status'), /selftest: turn running.*no holder/, 'a released holder is still reported');
    out('resume');
    await sleep(800);
    assert.ok(!fs.existsSync(path.join(dir, S + '.pid')), 'resume with nothing paused re-armed a released holder');
    run('busy', S); // restore the holder for the grace checks below
    pid = pidOf();
    await sleep(1000);
    assert.ok(alive(pid), 'busy did not re-arm after the resume check');

    run('idle', S);
    assert.match(out('status'), /selftest: turn finished.*grace/, 'status misses the grace state');
    await sleep(1000);
    assert.ok(alive(pid), 'holder released inside the grace window');
    run('busy', S); // a new turn inside the grace carries on with the same holder
    assert.strictEqual(pidOf(), pid, 'busy inside the grace did not reuse the holder');
    await sleep(1000);
    assert.ok(alive(pid), 'holder released with the marker back');

    run('idle', S);
    await sleep(2500 + 1500);
    assert.ok(!alive(pid), 'holder still running after the grace');

    run('busy', S);
    const pid2 = pidOf();
    await sleep(2000);
    assert.ok(alive(pid2));
    run('stop', S);
    await sleep(800);
    assert.ok(!alive(pid2), 'stop did not kill the holder');
    assert.ok(!fs.existsSync(mf), 'stop left the marker');

    // A live pid in the pid file is a holder even when the file has gone stale (the machine slept
    // mid-turn): `busy` must not spawn a second holder, and `stop` keeps the freshness rule so a
    // recycled PID is never killed -- so the record of the holder it did not kill must survive.
    // process.pid stands in for the stale-but-live holder.
    const S2 = 'stale-holder';
    const pf2 = path.join(dir, S2 + '.pid');
    fs.writeFileSync(pf2, String(process.pid));
    const oldPid = new Date(Date.now() - 10 * 60000);
    fs.utimesSync(pf2, oldPid, oldPid);
    run('busy', S2);
    assert.strictEqual(parseInt(fs.readFileSync(pf2, 'utf8'), 10), process.pid,
      'a stale pid file with a live pid was not treated as a holder');
    run('stop', S2);
    assert.ok(fs.existsSync(pf2), 'stop deleted the record of a live holder it did not kill');
    assert.strictEqual(parseInt(fs.readFileSync(pf2, 'utf8'), 10), process.pid,
      'stop rewrote the live holder record');
    assert.ok(alive(process.pid), 'stop killed a stale-but-live pid');

    // runner watcher, with a file standing in for Runner.Worker
    const job = path.join(dir, 'job');
    const e3 = { ...e2, KEEPAWAKE_RUNNER_FILE: job };
    const startR = () => cp.spawnSync(process.execPath, [__filename, 'runners'], { env: e3, timeout: 15000 });
    const stat = () => cp.spawnSync(process.execPath, [__filename, 'status'], { env: e3, encoding: 'utf8', timeout: 15000 }).stdout;
    const until = async (fn, ms) => { for (const t = Date.now(); Date.now() - t < ms; await sleep(200)) if (fn()) return true; return false; };
    startR();
    assert.ok(await until(() => /runner watcher: .*idle/.test(stat()), 5000), 'watcher not idle with no job');
    const rpid = rpidOf();
    startR();
    assert.strictEqual(rpidOf(), rpid, 'second `runners` started a second watcher');
    fs.writeFileSync(job, '');
    assert.ok(await until(() => /holding the machine awake/.test(stat()), 10000), 'watcher did not hold for a job');
    fs.rmSync(job);
    await sleep(1200);
    assert.match(stat(), /holding/, 'watcher released inside the grace');
    assert.ok(await until(() => /runner watcher: .*idle/.test(stat()), 6000), 'watcher still holding after the grace');
    assert.ok(alive(rpid), 'watcher exited instead of going idle');
  } finally {
    try { process.kill(rpidOf()); } catch { /* gone or never started */ }
    try { process.kill(pidOf()); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`keepawake: selftest ok (${process.platform}, stale ${mins(STALE_MS)}m, grace ${mins(GRACE_MS)}m)`);
}

// ---------------------------------------------------------------- main
const mode = process.argv[2];
if (mode === 'selftest') {
  selftest().catch((e) => { console.error('keepawake: selftest FAILED:', e.message); process.exit(1); });
} else if (mode === 'hold') {
  hold(process.argv[3]).catch(() => process.exit(1));
} else if (mode === 'status') {
  console.log(statusLines().join(String.fromCharCode(10)));
} else if (mode === 'runners') {
  cmdRunners();
} else if (mode === 'runners-watch') {
  watchRunners().catch(() => process.exit(1));
} else if (mode === 'install-runners') {
  cmdInstallRunners();
} else if (mode === 'uninstall-runners') {
  cmdUninstallRunners();
} else if (mode === 'pause') {
  cmdPause(process.argv[3]);
} else if (mode === 'resume') {
  cmdResume();
} else if (['busy', 'beat', 'idle', 'stop'].includes(mode)) {
  const sess = sessionId(readPayload());
  if (sess) ({ busy: cmdBusy, beat: cmdBeat, idle: cmdIdle, stop: cmdStop })[mode](sess);
  process.exit(0);
} else {
  console.error('usage: keepawake.js busy|beat|idle|stop|status|pause [minutes]|resume|hold <session>|runners|runners-watch|install-runners|uninstall-runners|selftest');
  process.exit(2);
}
