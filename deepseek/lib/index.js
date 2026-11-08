// DeepSeek Harness (DSH) version of this plugin. DSH has no Claude Code hook bridge; it loads
// Cordis bundles, so this file maps DSH's durable session events and live agent status onto the
// same keepawake.js CLI modes:
//
//   agent/status running                         -> busy   (a turn is really running)
//   agent/status idle                            -> idle   (a turn finished)
//   session/event turn/start                     -> busy   (covers admission -> start)
//   session/event step/start                     -> busy   (re-arms after a plugin reload mid-turn)
//   session/event tool/call                      -> busy/beat (also refreshes; PreToolUse)
//   session/event tool/result                    -> beat   (PostToolUse)
//   session/event turn/end                       -> idle, then busy for jobs still running (Stop)
//   session/event job/registered                 -> tracked; holds only if still running at turn/end
//   session/event job/settled                    -> idle   (dsh-job-<id>)
//   session/event session/disposed               -> stop   (SessionEnd)
//   agent/disposed                               -> stop
//
// All of the release policy (grace, stale ceiling, AC/battery cap, pause, notifications) stays in
// keepawake.js; this file only maps events onto its CLI modes. Requires `node` on PATH, like the
// Claude Code hooks.
//
// Load it as a DSH bundle (`cordis.patch.yml` inserts this package). `config.path` overrides the
// sibling `keepawake.js`; the default is `<repo>/keepawake.js` for a checkout-linked install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Background jobs have a session of their own and one may outlive the turn that started it, so
// each gets a lock under a synthetic session name.
const JOB = 'dsh-job-';

// This file lives at <repo>/deepseek/lib/index.js when the package is linked in place.
function libDir() {
  try { if (import.meta.dirname) return import.meta.dirname; } catch { /* older runtime */ }
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return ''; }
}

// config.path wins; otherwise keepawake.js sits two levels above lib/.
function resolveScript(config) {
  if (typeof config?.path === 'string' && config.path) return config.path;
  const dir = libDir();
  return dir ? path.join(dir, '..', '..', 'keepawake.js') : '';
}

// Fire-and-forget: these hooks sit in front of every model step and tool call, so they must never
// wait on the child. A missing marker is a no-op inside keepawake.js, so a late beat cannot
// resurrect a turn.
function makeSend(file) {
  let warned = false;
  return (mode, sessionID) => {
    if (!sessionID) return;
    if (!file || !fs.existsSync(file)) {
      if (warned) return;
      warned = true;
      // No transcript to fail into, so the Harness log is the only visible surface.
      console.error(`keepawake: cannot find keepawake.js at "${file || '?'}"; set config.path to its full path.`);
      return;
    }
    const child = spawn('node', [file, mode], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', (e) => {
      if (warned) return;
      warned = true;
      console.error(`keepawake: could not run node ${file}: ${e.message}`);
    });
    child.stdin.on('error', () => {}); // keepawake may exit before draining stdin
    child.stdin.end(JSON.stringify({ session_id: String(sessionID) }));
    child.unref();
  };
}

const sessionIdOf = (session) => session?.id;
const agentIdOf = (payload) => payload?.agent?.id;

/**
 * Register the keep-awake event mapping with DSH.
 * @param {any} ctx - Cordis context.
 * @param {{ path?: string }} [config] - bundle options.
 */
export function apply(ctx, config) {
  const file = resolveScript(config);
  if (!file || !fs.existsSync(file)) {
    throw new Error(`keepawake: cannot find keepawake.js at "${file || '?'}"; set config.path to its full path.`);
  }
  const send = makeSend(file);

  const owned = new Set(); // keys this instance holds, for the unload cleanup
  const liveJobs = new Map(); // session -> job ids registered during its current turn

  const jobKey = (jobId) => JOB + jobId;

  // Creates the marker only when this instance does not hold it yet; keepawake.js touches an
  // existing marker on busy, so re-arming after a reload stays a single call.
  const acquire = (key) => {
    if (!key || owned.has(key)) return;
    owned.add(key);
    send('busy', key);
  };
  const release = (key) => {
    if (!key) return;
    owned.delete(key);
    send('idle', key);
  };
  const stop = (key) => {
    if (!key) return;
    owned.delete(key);
    send('stop', key);
  };
  const stopSession = (key) => {
    for (const jobId of liveJobs.get(key) ?? []) stop(jobKey(jobId));
    liveJobs.delete(key);
    stop(key);
  };
  // A background job can outlive every turn, so any activity on this instance refreshes the job
  // markers it owns: a working session must not let a long job hit the stale ceiling.
  const beatJobs = () => { for (const key of owned) if (key.startsWith(JOB)) send('beat', key); };

  ctx.on('agent/status', (payload) => {
    const key = agentIdOf(payload);
    if (!key) return;
    if (payload.status === 'running') acquire(key);
    else if (payload.status === 'idle') release(key);
    beatJobs();
  });

  ctx.on('session/event', (session, event) => {
    const key = sessionIdOf(session);
    if (!key || !event) return;
    switch (event.type) {
      case 'turn/start':
      case 'step/start':
        acquire(key);
        beatJobs();
        break;
      case 'tool/call':
        if (owned.has(key)) send('beat', key); else acquire(key);
        beatJobs();
        break;
      case 'tool/result':
        send('beat', key);
        beatJobs();
        break;
      case 'job/registered': {
        const jobId = event.data?.jobId;
        if (!jobId) break;
        // Track the job for this session; the turn marker already covers it. It gets its own
        // marker at turn/end only if it is still running then, so an ordinary tool call does not
        // spawn a holder of its own.
        const jobs = liveJobs.get(key) ?? new Set();
        jobs.add(jobId);
        liveJobs.set(key, jobs);
        if (!owned.has(key)) acquire(jobKey(jobId)); // a reloaded plugin missed the turn edge
        break;
      }
      case 'job/settled': {
        const jobId = event.data?.jobId;
        if (!jobId) break;
        const jobs = liveJobs.get(key);
        if (jobs) {
          jobs.delete(jobId);
          if (jobs.size === 0) liveJobs.delete(key);
        }
        release(jobKey(jobId));
        break;
      }
      case 'turn/end':
        release(key);
        // Jobs still running now will outlive the turn, so each gets its own holder. A job that
        // settled inside the turn was removed above and never took one.
        for (const jobId of liveJobs.get(key) ?? []) acquire(jobKey(jobId));
        break;
    }
  });

  ctx.on('session/disposed', (session) => { stopSession(sessionIdOf(session)); });
  ctx.on('agent/disposed', (payload) => { stopSession(agentIdOf(payload)); });

  return () => {
    // Unload/reload: clear the markers now; holders release after the grace period, and the next
    // step or tool call re-arms if a turn is still running.
    for (const key of owned) send('idle', key);
    owned.clear();
    liveJobs.clear();
  };
}
