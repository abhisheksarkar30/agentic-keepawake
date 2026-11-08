# DeepSeek Harness bundle

Keep the machine awake from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH), using the same [`keepawake.js`](../keepawake.js) holder and release policy as the Claude Code
and OpenCode versions. DSH loads **Cordis bundles**, not Claude Code hooks or OpenCode plugins, so
this directory is the adapter: it maps DSH events onto `keepawake.js`'s CLI modes and owns no sleep
logic of its own.

## Layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | The Cordis plugin. Subscribes to `agent/status`, durable `session/event`s, and disposal. |
| `cordis.patch.yml` | The bundle layer DSH applies: one `insert` of this package as a profile plugin. |
| `locale/en.json` | Plugin Manager title and description. |
| `icon.svg` | Plugin Manager icon. |
| `test-plugin.mjs` | Smoke test against a stub Cordis context (`node deepseek/test-plugin.mjs`). |

## Install

DSH installs **bundles**: npm packages that declare `dsh.bundle.patch`. This directory is one.

### Option A — ask the harness

In a DSH session, ask it to install the bundle from this checkout:

> Install the bundle at `D:\github\agentic-keepawake\deepseek` in this profile.

That calls `plugin_manager` → `install_bundle`, which links the checkout and selects the bundle.
The desktop profile has HMR, so the plugin starts immediately; a profile without HMR needs a
restart. Removing it is the same operation in reverse.

### Option B — profile files

`~/.dsh/profiles/<profile>/package.json` gains the dependency, and `dsh.profile.bundles` the
selection:

```json
{
  "dependencies": {
    "agentic-keepawake-dsh": "link:D:/github/agentic-keepawake/deepseek"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "agentic-keepawake-dsh"
      ]
    }
  }
}
```

Then run the profile's package install (`dsh plugin --profile <profile> --help` lists the exact
command) and restart if HMR is off.

`node` must be on PATH. The plugin resolves `keepawake.js` from the checkout
(`<repo>/deepseek/lib` → `<repo>/keepawake.js`); a copied install can override that with a
`config.path` in the bundle row:

```yaml
- insert:
    - id: agentic-keepawake
      name: agentic-keepawake-dsh
      config:
        path: D:/somewhere/keepawake.js
```

## What maps to what

| DSH event | keepawake.js | Claude Code equivalent |
| --- | --- | --- |
| `agent/status` → `running` / `idle` | `busy` / `idle` | `UserPromptSubmit` / `Stop` |
| `turn/start` | `busy` | `UserPromptSubmit` (admission → start gap) |
| `step/start` | `busy`, only when not already held | re-arms after a reload mid-turn |
| `tool/call` | `busy` when missing, else `beat` | `PreToolUse` |
| `tool/result` | `beat` | `PostToolUse` |
| `turn/end` | `idle`, then `busy` for jobs still running (`dsh-job-<id>`) | `Stop` |
| `job/registered` | tracked; no holder while the turn covers it | — |
| `job/settled` | `idle` (`dsh-job-<id>`) | — |
| `session/disposed` / `agent/disposed` | `stop` | `SessionEnd` |

All of the release policy — the 5-minute grace, the 45-minute stale ceiling, the AC/battery cap,
`pause`/`resume`, notifications — stays in `keepawake.js`. The plugin only chooses `busy`, `beat`,
`idle` or `stop`; a missing marker makes `beat` a no-op, so a late event cannot resurrect a turn.

DSH's durable `turn/start` / `turn/end` events are the primary turn boundaries. `agent/status` is a
live edge: it releases a turn that finished without a terminal event. A plugin reloaded mid-turn
re-arms on the next `step/start` or `tool/call`, which is the same recovery shape as the OpenCode
plugin's `session.hook("context")`.

While a turn runs, its marker already covers every job the turn starts. A job still running at
`turn/end` gets its own holder under the synthetic session name `dsh-job-<id>`; a job that settled
inside the turn never takes one. Activity on this plugin instance refreshes the job markers it
owns, so a long job outlives many turns; 45 minutes with no activity still hits the stale ceiling.
Jobs already running when the plugin loads are not rediscovered (DSH exposes no owner-relative job
inventory), and a job owned by another agent is refreshed only by that instance.

Subagents are separate DSH agents with their own sessions, so each one gets its own marker and
holder; the OS counts the inhibitors.

## Notes

- **The OpenCode package does not run here.** `opencode/index.js` uses OpenCode's `setup(ctx)` /
  `session.hook` / `session.execution.*` API; DSH exposes Cordis events instead, so loading it as a
  bundle fails. This directory is the DSH-native equivalent.
- **Hooks stay Claude-side.** DSH has no `~/.claude/settings.json` hook bridge; the plugin uses
  DSH's event stream rather than shelling out to Claude Code hooks.
- **Display metadata is minimal.** The bundle declares `meta.title` / `meta.description` and an
  icon for the Plugin Manager; it adds no Web UI surface.

## Test

```bash
node deepseek/test-plugin.mjs
```

Uses a stubbed Cordis context and the real `keepawake.js` in a temp state dir with
`KEEPAWAKE_BACKEND=none`, so it passes on any OS without touching the machine's sleep state.
