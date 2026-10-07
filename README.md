# agentic-keepawake

Keeps your machine awake **only while a Claude Code turn is actually running** — not merely because a
session is open. Windows, macOS and Linux. One file of node, no dependencies, no Electron, no tray.

The display is left alone, so the screen still sleeps on its own timer. A *user-initiated* sleep
(lid close, power button) still wins.

## Install

Local marketplace (loads in place; `/reload-plugins` after edits):

```
/plugin marketplace add D:\github\agentic-keepawake
/plugin install agentic-keepawake@agentic-keepawake
```

Needs `node` on PATH. If it is missing the hooks fail visibly in the transcript; there is no silent
degraded mode.

## How it works

| Hook | Runs | Does |
|---|---|---|
| `UserPromptSubmit` | `keepawake.js busy` | sets `~/.claude/keepawake/<session>.busy`, ensures one detached holder |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `keepawake.js beat` (async) | refreshes the marker's mtime, only if it exists |
| `Stop` / `StopFailure` | `keepawake.js idle` | clears the marker |
| `SessionEnd` | `keepawake.js stop` | clears the marker and kills the holder |

`PostToolUse` fires only on success, hence the separate failure entry. `PermissionRequest` and
`Notification` deliberately do **not** refresh the marker: they mean Claude is waiting on you, not working.

The holder owns an OS sleep inhibitor and polls the marker every 30 s:

| OS | Inhibitor | Released by the OS if the holder dies because |
|---|---|---|
| Windows | hidden `powershell` holding `SetThreadExecutionState(ES_SYSTEM_REQUIRED)` | its stdin pipe closes |
| macOS | `caffeinate -i -w <holder pid>` | the watched pid exits |
| Linux | `systemd-inhibit --what=sleep:idle --mode=block cat` | `cat` sees stdin close |

Concurrent sessions need no bookkeeping: each has its own holder and the OS counts the inhibitors.

### When a holder lets go

- **Turn finished** — marker gone, plus a 5-minute grace. The grace covers a follow-up no
  `UserPromptSubmit` announces (background-task wake-up, Stop-hook continuation, a prompt typed seconds
  later). A new prompt inside it reuses the same holder. Skipped on `SessionEnd`.
- **Marker stale** — no refresh for 45 min (Esc does not fire `Stop`; a crash fires nothing). No grace.
- **You have been away past the cap** — 6 h on AC, 3 h on battery, evaluated live so unplugging takes
  effect at once. Input idle time is read from `GetLastInputInfo` (Windows), `HIDIdleTime` (macOS) or
  `xprintidle` (Linux/X11). Where it cannot be read, the cap falls back to wall-clock time since the busy
  period began. No grace.

Early releases (stale / cap), a plug or unplug that moves the cap, a sleep request the OS refuses, and an
inhibitor that dies unexpectedly raise a desktop notification (Windows toast, `osascript`, `notify-send`).
A normal turn-finished release stays silent, or every prompt would notify.

`stop` only kills a pid whose pid file the holder has refreshed recently, so a recycled PID is never
terminated by mistake.

## Inspect and control

```
node keepawake.js status        # each session: running / finished (in grace) / stale marker, its holder pid
node keepawake.js pause [min]   # stop holding the machine awake (for min minutes, else until resume)
node keepawake.js resume
```

`pause` is one global flag file (`~/.claude/keepawake/paused`). Holders notice it within one poll (30 s),
release their sleep lock, and take it back on `resume` or when the timed pause expires; the turn, marker
and grace logic carry on meanwhile. There is deliberately no tray icon: these three commands plus the
notifications cover it without a per-OS GUI dependency.

`KEEPAWAKE_BACKEND=none` runs everything without taking any OS lock. It exists for CI on a runner with no
logind session, where `systemd-inhibit` is denied (`Failed to inhibit: Access denied`).

## Check

```
node keepawake.js selftest
```

Drives the whole release policy as a pure function, smoke-tests the backend for the current OS, then runs
a real holder end to end in a temp dir on short timers (~6 s).

## Status

- **Windows: tested** — selftest passes; no orphaned `powershell` left behind.
- **macOS and Linux: written, not run.** The backends follow the documented behaviour of `caffeinate -w`
  and `systemd-inhibit`, but run `selftest` on each before trusting it.
- **Modern Standby (Windows):** not handled. If `ES_SYSTEM_REQUIRED` does not survive the display turning
  off on your laptop, the upgrade path is `PowerCreateRequest` with `ExecutionRequired` (or holding the
  display). Check with `powercfg /requests` from an admin shell while a turn runs with the screen off.

## Known limits

- A single silent tool call longer than 45 min is released early.
- A holder that has released on the cap does not re-arm until the next prompt (a restart on tool activity
  would pin the machine past the cap).
- `Stop` is not fired on Esc; the stale ceiling is the safety net.

## Prior art

Design drew on [stanley-projects/Insomnia](https://github.com/stanley-projects/Insomnia) (hook events,
liveness fallback), [dakotahp/agentic-insomnia](https://github.com/dakotahp/agentic-insomnia) (post-turn
grace, stdin-pipe crash release, native backends) and
[benbasha/Claude-Autopilot](https://github.com/benbasha/Claude-Autopilot) (what not to do).
