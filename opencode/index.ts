// OpenCode version of this plugin. Mirrors hooks/hooks.json onto OpenCode V2 hooks:
//
//   session.execution.started                 -> busy   (UserPromptSubmit: a turn is really running)
//   prompt                                    -> busy   (UserPromptSubmit: covers admission -> start)
//   tool execute.before                       -> beat   (PreToolUse)
//   tool execute.after                        -> beat   (PostToolUse / PostToolUseFailure)
//   session.execution.succeeded/failed/interrupted -> idle   (Stop / StopFailure)
//   session.idle                              -> idle   (Stop; not emitted by every OpenCode build)
//   session.deleted                           -> stop   (SessionEnd)
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

// The plugin directory is <repo>/opencode when the directory is loaded in place.
function pluginDir() {
  try { if (import.meta.dirname) return import.meta.dirname; } catch { /* older runtime */ }
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return ''; }
}

function defaultScript() {
  const dir = pluginDir();
  return dir ? path.join(dir, '..', 'keepawake.js') : '';
}

let script = defaultScript();
let warned = false;

// Fire-and-forget: these hooks sit in front of every tool call, so they must never wait on the
// child. A missing marker is a no-op inside keepawake.js, so a late beat cannot resurrect a turn.
function send(mode, sessionID) {
  if (!sessionID) return;
  const child = spawn('node', [script, mode], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  child.on('error', (e) => {
    if (warned) return;
    warned = true;
    // No transcript to fail into, so the server log is the only visible surface.
    console.error(`keepawake: could not run node ${script}: ${e.message}`);
  });
  child.stdin.on('error', () => {}); // keepawake may exit before draining stdin
  child.stdin.end(JSON.stringify({ session_id: String(sessionID) }));
  child.unref();
}

const sessionOf = (event) => event?.sessionID || event?.session?.id;

export default {
  id: 'agentic-keepawake',
  async setup(ctx) {
    if (typeof ctx.options?.path === 'string') script = ctx.options.path;
    if (!script || !fs.existsSync(script)) {
      throw new Error(`keepawake: cannot find keepawake.js at "${script || '?'}"; set options.path to its full path.`);
    }

    await ctx.session.hook('prompt', (event) => { send('busy', sessionOf(event)); });
    await ctx.tool.hook('execute.before', (event) => { send('beat', sessionOf(event)); });
    // Covers both outcomes: OpenCode reports failures here too (the PostToolUseFailure equivalent).
    await ctx.tool.hook('execute.after', (event) => { send('beat', sessionOf(event)); });

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
          ],
          signal: abort.signal,
        })) {
          if (typeof event.created === 'number' && event.created < startedAt - 1000) continue;
          const sessionID = event?.data?.sessionID || event?.data?.id;
          if (event.type === 'session.execution.started') send('busy', sessionID);
          else send(event.type === 'session.deleted' ? 'stop' : 'idle', sessionID);
        }
      } catch (e) {
        if (!abort.signal.aborted) console.error(`keepawake: event stream failed: ${e.message}`);
      }
    })();

    return () => abort.abort();
  },
};
