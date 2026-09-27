# Claude Prompt Monitor

Know the moment Claude Code needs you, and the moment it is done — without watching the terminal.

The extension tracks every prompt you send to Claude Code. It shows live progress, estimates the time
to completion from your own past prompts, and tells you when Claude is blocked on you: a question, a
plan to approve, a permission prompt. When a prompt ends you get the result, what it changed, and a
one-click diff of exactly that prompt's edits.

It works for **both** the Claude Code VS Code extension and Claude Code running in a terminal (inside
VS Code or anywhere else on the machine), because it reads the session transcripts Claude Code writes to
`~/.claude/projects/`. Nothing is sent anywhere, and Claude Code itself is not modified or wrapped.

## The idea

A long prompt is something you walk away from. The monitor's job is to spend your attention only when
it is worth it, and to answer "what happened?" in one glance when you come back. Every running prompt is
in one of four states, and every surface — status bar, Monitor panel, notifications, desktop widget —
shows the same one:

| State | What it means | What you see |
| --- | --- | --- |
| **Needs you** | Claude asked a question, has a plan for you to approve, or is showing a permission prompt. It cannot continue. | Amber everywhere, the question in the notification, the clock paused |
| **Working** | Generating or running tools. | Elapsed / ETA, the current step and how long it has run, `3/7` tasks |
| **Retrying** | The API call failed (overloaded, connection dropped) and Claude Code is retrying. | `retrying 3/10` and the error |
| **Agents** | The reply is done but agents it launched in the background are still working; Claude resumes when they report back. | Which agents, and what each is doing |

When it ends: **done** (with Claude's closing sentence and the files changed), **stopped** (with what to
do — "sign-in expired, run /login"), **usage limit** (with the reset time, and a second notification when
it resets), or **interrupted** (no notification — you did that).

## What you get

**Status bar** — the most urgent thing, always:

```
$(sync~spin) Claude 1:12 / ~2:30 · 3/7        working: elapsed / estimated total · tasks
$(bell-dot) Claude needs you · ai_patro         amber: Claude is waiting on you
$(organization) Claude · 2 agents running       reply done, background agents still out
$(watch) Claude limit · resets 12:25 PM         nothing running, usage limit in force
```

A `?` after the estimate means there is not enough history yet for a confident number. Hover for every
running session: the prompt, the question it is waiting on, the current step and how long that tool
call has been running, tasks, agents and changed files. Click to open the Monitor panel.

**Monitor panel** (activity bar) — three parts:

- *Now*: one card per running session, most urgent first — its state in words, the conversation title,
  the question it is waiting on, a progress bar, the current step, tasks, agents and changed files, with
  Open Claude, Changes and Transcript buttons.
- *Today*: prompts sent, time Claude worked, time Claude spent waiting on you, files changed.
- *Recent*: finished prompts, newest first. Expand one for Claude's closing line, each changed file
  (click to see its diff), and Review changes, Copy prompt, Transcript and Open Claude.

**Sessions view** — one row per session, titled by the conversation. Under it: what Claude is waiting
for or why it stopped, the task list, agents, changed files, then every step of the turn, newest first,
with failed tool calls marked and a live timer on a tool call that is still running.

**Notifications** — when Claude starts waiting on you:

> Claude is asking you in ai_patro (Release 1.4 build): “Commit the language fix only, or both commits?”

and when a prompt ends:

> Claude finished — car · 4m 12s · 6 files (+120 −14) · 23 tool calls · 1 agent — All 13 admin pages
> are redesigned in the same style as the dashboard.   **[Review Changes] [Open Claude] [Show]**

Short successful prompts are not announced (`notifyMinDurationSeconds`); errors and limits always are.

**Review changes** — every changed file opens against its state just before Claude first touched it in
that prompt, from Claude Code's own file-history backups. The diff is exactly that prompt's work, even
when you have other uncommitted changes. Several files open together in the multi-file changes editor.

**Optional progress notification** — a real progress bar with the current step and the time remaining,
for when you want the ETA in view without the status bar.

## Permission prompts

Questions and plan approvals are tool calls, so they are in the transcript the moment Claude makes them.
A permission prompt is not: nothing is written until you answer it. To be alerted to those too, run
**Claude Monitor: Install Permission Alert Hook** (or the button at the bottom of the Monitor panel).

It adds a `Notification` hook to `~/.claude/settings.json` — alongside any hooks you already have — and
copies a small script to `~/.claude/hooks/`. Claude Code runs it when it shows a permission prompt; the
script appends the event to a local file the extension watches, and exits. Nothing leaves the machine.
`settings.json` is backed up to `settings.json.before-claude-prompt-monitor` first, and **Remove
Permission Alert Hook** takes the entry and the script out again. It applies to sessions started after
installing.

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
ai_patro · Release 1.4 build                    x
1:23 / ~3:16   12 tools   3/7 tasks
--------------------------------
Bash 0:42 - flutter build appbundle --release
```

It shows the same states as everything else, with a coloured strip down its left edge:

```
Needs you · ai_patro · Release 1.4 build        (amber, flashes once per new question)
What to commit and push to origin/main? ...
waiting 2:14   ·   the clock is paused
```

When nothing is running it keeps the last result on screen for three minutes, since a glance after
walking back is when the result matters:

```
Done · car                                      (green; red if it stopped, amber for a limit)
4m 12s   ·   6 files +120 −14   ·   23 tools
All 13 admin pages are redesigned in the same style as the dashboard.
```

It runs as its own process, so minimising or closing VS Code does not take it away, and it estimates
with or without the extension:

- While VS Code is running it reads the extension's status file, which carries the estimate straight
  from the extension's own history.
- Otherwise it reads the transcripts directly. Elapsed time, tool count and the current step come from
  the running turn; the estimate comes from the completed turns in the same file tails, plus the
  history file the extension publishes if it has ever run. The quantile walk is the same one the
  extension uses, so the number means the same thing.

With several prompts running it shows the most urgent — one waiting on you first — then the one you
have been waiting on longest, plus a `+n more` count. Without VS Code it still spots a question or an
interrupt in the transcript, but not background agents, tasks or permission prompts.
The transcript scan runs every 3 seconds rather than on every frame — it costs about 180ms and the
window would stutter otherwise — while the clock keeps ticking every half second from the cached start
times.

Set `claudePromptMonitor.overlayAutoStart` to open it automatically whenever a prompt starts or Claude
starts waiting on you. Only one
widget ever runs: opening it again brings the existing one to the front instead of starting a second,
and pulls it back into view if it ended up off-screen. Windows only for now.

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

Every completed prompt is recorded locally: how long Claude worked on it, number of tool calls, prompt
length, and the project it ran in. Time Claude spent blocked on you — answering a question, approving a
plan or a permission — is not Claude's time, so it is left out; while Claude waits, the estimate's clock
pauses. Prompts started by a background task, not by you, are not recorded. When a new prompt starts, the estimate is the median duration of comparable past
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
| `claudePromptMonitor.notifyOnComplete` | `true` | Notify when a prompt finishes, stops with an error, or hits a usage limit. |
| `claudePromptMonitor.notifyOnWaiting` | `true` | Notify the moment Claude is blocked on you: a question, a plan to approve, or (with the hook) a permission prompt. |
| `claudePromptMonitor.notifyOnLimitReset` | `true` | After a usage limit, notify again when it resets. |
| `claudePromptMonitor.notifyMinDurationSeconds` | `15` | Skip the notification for successful prompts faster than this. Errors and limits are always reported. |
| `claudePromptMonitor.notifyOnlyWhenUnfocused` | `false` | Only notify when the VS Code window is in the background. |
| `claudePromptMonitor.notificationTarget` | `editor` | `editor` for a VS Code toast, `native` for an OS desktop notification that shows while VS Code is minimised, `both`. |
| `claudePromptMonitor.overlayAutoStart` | `false` | Open the desktop widget automatically when a prompt starts or Claude waits on you (Windows). |
| `claudePromptMonitor.playSound` | `false` | Play a short system sound on completion and when Claude starts waiting on you. |
| `claudePromptMonitor.showProgressNotification` | `false` | Show a live progress notification while a prompt runs. |
| `claudePromptMonitor.statusBar` | `true` | Show elapsed time and ETA in the status bar. |
| `claudePromptMonitor.claudeHome` | `""` | Override the Claude home directory. Defaults to `$CLAUDE_CONFIG_DIR`, else `~/.claude`. |
| `claudePromptMonitor.pollIntervalMs` | `800` | How often transcripts are checked for new output. |
| `claudePromptMonitor.staleTurnMinutes` | `30` | A running turn with no output for this long is treated as abandoned (a turn waiting on you never is). Transcripts written within this window are replayed after a window reload. |
| `claudePromptMonitor.historySize` | `200` | Completed prompts kept per project for estimating. |

## Shortcuts

The Monitor panel's title bar has the desktop widget toggle. The Sessions view title bar has **Review
Changes**, **Timing Stats** and **Refresh**, with notifications, transcripts, the permission hook and the
clear commands under the `...` menu. Right-click a session for **Go to Claude** and **Open Session
Transcript**.

| Keys | Does |
| --- | --- |
| `Ctrl+Alt+M` (`Cmd+Alt+M`) | Toggle the desktop widget |
| `Ctrl+Alt+Shift+M` (`Cmd+Alt+Shift+M`) | Focus the Monitor panel |

Rebind either in **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`), searching for "Claude Monitor".

## Commands

- **Claude Monitor: Show Monitor** / **Show Sessions**
- **Claude Monitor: Open Desktop Widget** / **Toggle Desktop Widget** — the always-on-top status window.
- **Claude Monitor: Review Changes from the Last Prompt** — each file against its state before that
  prompt.
- **Claude Monitor: Go to Claude** — focuses the Claude Code panel (or the terminal, for a CLI session).
- **Claude Monitor: Install Permission Alert Hook** / **Remove Permission Alert Hook**
- **Claude Monitor: Toggle Completion Notifications**
- **Claude Monitor: Show Timing Stats** — how many prompts are recorded for this project, with the
  median and 90th-percentile time Claude worked.
- **Claude Monitor: Clear Timing History** / **Clear Recent Prompts**
- **Claude Monitor: Open Session Transcript** — opens the raw `.jsonl` for a session.
- **Claude Monitor: Refresh**

## Install

```
npm install
npm run compile
npm run package        # produces the .vsix
code --install-extension somshrestha-claude-prompt-monitor-<version>.vsix --force
```

Press `F5` in this folder to run it in an Extension Development Host instead.

## Working on it

`docs/NOTES.md` has the development notes: setup on a new machine, the release steps, and the traps
that cost the most time (a VS Code window keeps running the build it started with; `detached: true`
kills GUI child processes on Windows).

## Limits worth knowing

- A prompt is finished when Claude's reply ends its turn and any background agents it launched have
  reported back. An interrupted prompt ends at once and is left out of the timing history — an
  interrupted run says nothing useful about how long the work takes.
- Permission prompts are only detected with the hook installed. With it, a permission wait ends at the
  next thing the transcript records — for an approved long command that is when the command finishes,
  so "needs you" can linger after you have approved it.
- The before-state for Review Changes comes from Claude Code's checkpoints (file history). Files without
  one — checkpointing off, or changed by a shell command rather than Claude's edit tools — fall back to
  the git diff.
- Progress is derived from transcript output, so a long single tool call (a big build, a slow test run)
  looks like one step until it returns. Elapsed time keeps moving; the step list does not.
- Estimates are per project. A new project starts with the global history until it has three prompts of
  its own.
- The status bar and panels are VS Code surfaces. For status without VS Code in front of you, use the
  desktop widget, `notificationTarget: native`, or the Stop hook.
- The widget and the Stop hook are Windows-only. Native notifications work on all three platforms.
