# Claude Prompt Monitor

Know when Claude Code is done — and roughly how long it will take — without watching the terminal.

The extension tracks every prompt you send to Claude Code, shows live progress while it runs, estimates
the time to completion from your own past prompts, and notifies you the moment the prompt finishes.

It works for **both** the Claude Code VS Code extension and Claude Code running in a terminal (inside
VS Code or anywhere else on the machine), because it reads the session transcripts Claude Code writes to
`~/.claude/projects/`. Nothing is sent anywhere, and Claude Code itself is not modified or wrapped.

## What you get

**Status bar** — while a prompt is running:

```
$(sync~spin) Claude 1:12 / ~2:30
```

Elapsed time, then the estimated total. A `?` after the estimate means there is not enough history yet
for a confident number. Hover for the prompt, the current tool call and the time left. Click to open the
Sessions view.

**Sessions view** (activity bar) — one row per Claude session, expanded into the steps of the current
turn: each tool call, its target, and how far into the turn it happened. Finished sessions keep their
last turn so you can see what took the time.

**Completion notification** — when a prompt ends:

> Claude finished in my-project — 2m 14s · 18 tool calls · 12.3k tokens out

Short prompts are ignored by default (see `notifyMinDurationSeconds`), so you are only interrupted for
the ones you actually walked away from.

**Optional progress notification** — a real progress bar with the current step and the time remaining,
for when you want the ETA in view without the status bar.

## Notifications outside VS Code

By default the completion notification is a VS Code toast, which you only see if a VS Code window is
open and in front of you. That is the wrong place for the case this extension exists for — walking away
from a long prompt.

Set `claudePromptMonitor.notificationTarget` to `native` (or `both`) and the notification goes to the
operating system instead: Windows toast, macOS notification centre, `notify-send` on Linux. It shows
while VS Code is minimised or behind another window.

The prompt text is passed to the OS through the environment or as separate argv entries, never as part
of a shell string, so nothing in a prompt can be interpreted as a command.

### Desktop widget

`Claude Monitor: Open Desktop Widget` opens a small always-on-top window that sits above every other
application and stays there until you close it — the x in its corner, or Esc. Drag it anywhere; it
remembers where you put it.

```
ai_patro                                        x
1:23 / ~3:16   12 tools
--------------------------------
Bash - add release notes for the 1.4 build
```

It runs as its own process, so minimising or closing VS Code does not take it away, and it estimates
with or without the extension:

- While VS Code is running it reads the extension's status file, which carries the estimate straight
  from the extension's own history.
- Otherwise it reads the transcripts directly. Elapsed time, tool count and the current step come from
  the running turn; the estimate comes from the completed turns in the same file tails, plus the
  history file the extension publishes if it has ever run. The quantile walk is the same one the
  extension uses, so the number means the same thing.

With several prompts running it shows the one you have been waiting on longest, plus a `+n more` count.
The transcript scan runs every 3 seconds rather than on every frame — it costs about 180ms and the
window would stutter otherwise — while the clock keeps ticking every half second from the cached start
times.

Set `claudePromptMonitor.overlayAutoStart` to open it automatically whenever a prompt starts. Launching
it twice does nothing: it holds a single-instance lock. Windows only for now.

### With VS Code closed entirely

For terminal-only use, `hooks/claude-stop-toast.ps1` is a standalone Windows Stop hook. It needs no VS
Code and no extension — Claude Code runs it when a prompt ends, and it reads the transcript itself for
the duration and tool count. Copy it somewhere permanent, then register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\you\\.claude\\hooks\\claude-stop-toast.ps1\""
          }
        ]
      }
    ]
  }
}
```

It stays silent for prompts under 15 seconds, always exits 0 so it can never fail a turn, and finishes
in about half a second — it reads the last few megabytes of the transcript directly rather than using
`Get-Content -Tail`, which takes ~37 seconds on a large transcript and would block Claude Code for that
whole time.

If you already have a `Stop` hook, add this one to the existing `hooks` array rather than replacing it.

## How the estimate works

Every completed prompt is recorded locally: duration, number of tool calls, prompt length, and the
project it ran in. When a new prompt starts, the estimate is the median duration of comparable past
prompts **in the same project**.

While the prompt runs the estimate is re-derived from what has actually happened:

- Elapsed time rules out the quick outcomes — once you pass the median, the estimate moves up to the
  75th percentile, then the 90th, then the 98th.
- The number of tool calls so far rules out the samples that finished with less work than this one.

The effect is that the bar never claims a prompt is about to finish when it isn't. Measured against
~110 real prompts from this machine's own transcripts, the up-front estimate lands within 2× of the
real duration for 43% of prompts (median error 12%), and the live estimate was still ahead of the
actual finish 89% of the time at the halfway mark.

On first run the extension reads the tail of your recent transcripts, so estimates are useful from the
first prompt rather than after a week of use.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudePromptMonitor.enabled` | `true` | Master switch. |
| `claudePromptMonitor.scope` | `workspace` | `workspace` tracks only sessions whose working directory is inside an open folder; `all` tracks every Claude session on the machine. |
| `claudePromptMonitor.notifyOnComplete` | `true` | Notify when a prompt finishes. |
| `claudePromptMonitor.notifyMinDurationSeconds` | `15` | Skip the notification for prompts faster than this. |
| `claudePromptMonitor.notifyOnlyWhenUnfocused` | `false` | Only notify when the VS Code window is in the background. |
| `claudePromptMonitor.notificationTarget` | `editor` | `editor` for a VS Code toast, `native` for an OS desktop notification that shows while VS Code is minimised, `both`. |
| `claudePromptMonitor.overlayAutoStart` | `false` | Open the desktop widget automatically when a prompt starts (Windows). |
| `claudePromptMonitor.playSound` | `false` | Play a short system sound on completion. |
| `claudePromptMonitor.showProgressNotification` | `false` | Show a live progress notification while a prompt runs. |
| `claudePromptMonitor.statusBar` | `true` | Show elapsed time and ETA in the status bar. |
| `claudePromptMonitor.claudeHome` | `""` | Override the Claude home directory. Defaults to `$CLAUDE_CONFIG_DIR`, else `~/.claude`. |
| `claudePromptMonitor.pollIntervalMs` | `800` | How often transcripts are checked for new output. |
| `claudePromptMonitor.staleTurnMinutes` | `30` | A running turn with no output for this long is treated as abandoned. |
| `claudePromptMonitor.historySize` | `200` | Completed prompts kept per project for estimating. |

## Commands

- **Claude Monitor: Show Sessions**
- **Claude Monitor: Open Desktop Widget** — the always-on-top status window.
- **Claude Monitor: Toggle Completion Notifications**
- **Claude Monitor: Show Timing Stats** — how many prompts are recorded for this project, with the
  median and 90th-percentile duration.
- **Claude Monitor: Clear Timing History**
- **Claude Monitor: Open Session Transcript** — opens the raw `.jsonl` for a session.
- **Claude Monitor: Refresh**

## Install

```
npm install
npm run compile
npm run package        # produces the .vsix
code --install-extension somshrestha-claude-prompt-monitor-0.1.0.vsix
```

Press `F5` in this folder to run it in an Extension Development Host instead.

## Limits worth knowing

- A prompt is considered finished when Claude's reply ends its turn. If you interrupt a prompt, the turn
  is marked *abandoned* at your next prompt (or after `staleTurnMinutes`) and is left out of the timing
  history — an interrupted run says nothing useful about how long the work takes.
- Progress is derived from transcript output, so a long single tool call (a big build, a slow test run)
  looks like one step until it returns. Elapsed time keeps moving; the step list does not.
- Estimates are per project. A new project starts with the global history until it has three prompts of
  its own.
- The status bar and Sessions view are VS Code surfaces. For status without VS Code in front of you,
  use the desktop widget, `notificationTarget: native`, or the Stop hook.
- The widget and the Stop hook are Windows-only. Native notifications work on all three platforms.
