// OpenCode version of this plugin. Mirrors hooks/hooks.json onto OpenCode hooks:
//
//   prompt                                                -> busy   (UserPromptSubmit: covers admission -> start)
//   session.hook("context")                               -> busy   (each model dispatch re-arms a lost marker)
//   session.execution.started                             -> busy   (a turn is really running)
//   tool execute.before                                   -> busy   (also refreshes; PreToolUse)
//   tool execute.after                                    -> beat   (PostToolUse / PostToolUseFailure)
//   session.execution.succeeded/failed/interrupted        -> idle   (Stop / StopFailure)
//   session.idle                                          -> idle   (Stop; not emitted by every OpenCode build)
//   shell.created                                         -> busy   (a background shell outlives its turn)
//   shell.exited / shell.deleted                          -> idle
//   session.deleted                                       -> stop   (SessionEnd)
//
// All of the release policy (grace, stale ceiling, AC/battery cap, pause, notifications) stays in
// keepawake.js; this file only maps events onto its CLI modes. Requires `node` on PATH, like the
// Claude Code hooks.
//
// Load it from opencode.json(c):
//   { "plugins": [{ "package": "<this repo>/opencode" }] }
// or, if the copy lives elsewhere, [{ "package": "<dir>", "options": { "path": "<this repo>/keepawake.js" } }].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Background shells have no session of their own (shell events carry no sessionID) and one may
// outlive the turn that started it, so each gets a lock under a synthetic session name.
const SHELL = 'opencode-shell-';

// The plugin directory is <repo>/opencode when the directory is loaded in place.
function pluginDir() {
  try { if (import.meta.dirname) return import.meta.dirname; } catch { /* older runtime */ }
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return ''; }
}

// options.path wins; otherwise keepawake.js sits next to this directory. Resolved per plugin
// instance, because OpenCode can load the same package once per location with different options.
function resolveScript(options) {
  if (typeof options?.path === 'string') return options.path;
  const dir = pluginDir();
  return dir ? path.join(dir, '..', 'keepawake.js') : '';
}

// Fire-and-forget: these hooks sit in front of every tool call, so they must never wait on the
// child. A missing marker is a no-op inside keepawake.js, so a late beat cannot resurrect a turn.
function makeSend(file) {
  let warned = false;
  return (mode, sessionID) => {
    if (!sessionID) return;
    if (!file || !fs.existsSync(file)) {
      if (warned) return;
      warned = true;
      // No transcript to fail into, so the server log is the only visible surface.
      console.error(`keepawake: cannot find keepawake.js at "${file || '?'}"; set options.path to its full path.`);
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

const sessionOf = (event) => event?.sessionID || event?.session?.id;
const shellIdOf = (event) => event?.data?.info?.id || event?.data?.id || event?.data?.shellID;

export default {
  id: 'agentic-keepawake',
  async setup(ctx) {
    const file = resolveScript(ctx.options);
    if (!file || !fs.existsSync(file)) {
      throw new Error(`keepawake: cannot find keepawake.js at "${file || '?'}"; set options.path to its full path.`);
    }
    const send = makeSend(file);

    const owned = new Set(); // keys this instance holds, for the unload cleanup
    const waiting = new Map(); // session -> token of its pending session.wait()

    // Creates the marker only when this instance does not hold it yet; keepawake.js touches an
    // existing marker on `busy`, so re-arming after a reload stays a single call.
    const acquire = (key) => {
      if (!key || owned.has(key)) return;
      owned.add(key);
      waiting.delete(key); // an older wait must not release this turn
      send('busy', key);
    };
    const release = (key) => {
      if (!key) return;
      owned.delete(key);
      waiting.delete(key);
      send('idle', key);
    };
    // Second release path: session.wait() resolves through terminal cases where the lifecycle
    // stream does not emit an idle event.
    const waitRelease = (sessionID) => {
      if (!sessionID || typeof ctx.session.wait !== 'function') return;
      const token = {};
      waiting.set(sessionID, token);
      void ctx.session.wait({ sessionID }).catch(() => {}).finally(() => {
        if (waiting.get(sessionID) !== token) return;
        waiting.delete(sessionID);
        release(sessionID);
      });
    };
    // The marker is created once per turn; the wait is re-armed on every execution start, so a
    // missed terminal event still releases. A reloaded plugin re-arms at the next model dispatch.
    const acquireTurn = (sessionID) => {
      if (!sessionID) return;
      acquire(sessionID);
      waitRelease(sessionID);
    };
    // A background shell can outlive every turn, so any activity on this instance refreshes the
    // shell markers it owns: a working session must not let a long shell hit the stale ceiling.
    const beatShells = () => { for (const key of owned) if (key.startsWith(SHELL)) send('beat', key); };

    await ctx.session.hook('prompt', (event) => { acquire(sessionOf(event)); beatShells(); });
    await ctx.session.hook('context', (event) => { acquire(sessionOf(event)); beatShells(); });
    await ctx.tool.hook('execute.before', (event) => {
      const sessionID = sessionOf(event);
      if (owned.has(sessionID)) send('beat', sessionID); else acquire(sessionID);
      beatShells();
    });
    await ctx.tool.hook('execute.after', (event) => { send('beat', sessionOf(event)); beatShells(); });

    const abort = new AbortController();
    // A freshly loaded plugin can be handed the durable event-log tail, i.e. turns that ended
    // before setup. Acting on those would hold the machine awake for a turn nobody is running.
    const startedAt = Date.now();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            'session.execution.started',
            'session.execution.succeeded',
            'session.execution.failed',
            'session.execution.interrupted',
            'session.idle',
            'session.deleted',
            'shell.created',
            'shell.exited',
            'shell.deleted',
          ],
          signal: abort.signal,
        })) {
          if (typeof event.created === 'number' && event.created < startedAt - 1000) continue;
          switch (event.type) {
            case 'session.execution.started':
              acquireTurn(event?.data?.sessionID);
              beatShells();
              break;
            case 'session.deleted': {
              const sessionID = event?.data?.sessionID;
              owned.delete(sessionID);
              waiting.delete(sessionID);
              send('stop', sessionID);
              break;
            }
            case 'shell.created': {
              const id = shellIdOf(event);
              if (id) acquire(SHELL + id);
              break;
            }
            case 'shell.exited':
            case 'shell.deleted': {
              const id = shellIdOf(event);
              if (id) release(SHELL + id);
              break;
            }
            default:
              release(event?.data?.sessionID);
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) console.error(`keepawake: event stream failed: ${e.message}`);
      }
    })();

    return () => {
      abort.abort();
      // Unload/reload: clear the markers now; holders release after the grace period, and the next
      // model or tool call re-arms if a turn is still running.
      for (const key of owned) send('idle', key);
      owned.clear();
      waiting.clear();
    };
  },

  // OpenCode 1: sessions only (its event stream has no shell events). V1 calls
  // `server(input, options)`, so the plugin options are the second argument, not a property of `input`.
  async server(input, options) {
    const send = makeSend(resolveScript(options));
    return {
      event: async ({ event }) => {
        const p = event?.properties || {};
        if (event?.type === 'session.status' && p?.status?.type === 'busy') send('busy', p.sessionID);
        else if (event?.type === 'session.idle' || event?.type === 'session.error') send('idle', p.sessionID);
      },
    };
  },
};
