# Change Log

## 0.1.4

### Added

- **Knows when Claude is waiting on you.** A question (`AskUserQuestion`) or a plan to approve
  (`ExitPlanMode`) turns the status bar amber (`Claude needs you`), puts that session first everywhere,
  and sends a notification with the question itself. The estimate clock pauses while Claude waits, and
  time spent waiting is left out of the timing history. Setting: `notifyOnWaiting`.
- **Permission alerts (opt-in).** A permission prompt leaves no trace in the transcript until it is
  answered, so `Claude Monitor: Install Permission Alert Hook` adds a Claude Code Notification hook
  that tells the monitor the moment one appears. Your other hooks are kept, `settings.json` is backed up
  first, and `Remove Permission Alert Hook` takes it out again.
- **Monitor panel** in the sidebar: every running session as a card (most urgent first) with its state,
  question, progress, current step, tasks, agents and changed files; today's numbers (prompts, time
  Claude worked, time spent waiting on you, files changed); and a Recent list of finished prompts with
  Claude's closing line, the files each changed, and Review changes / Copy prompt / Transcript / Open
  Claude actions.
- **Review what a prompt changed.** Each changed file opens against its state just before Claude first
  edited it in that prompt, using Claude Code's own file-history backups, so the diff shows exactly that
  prompt's work (several files open in the multi-file changes editor). Falls back to the git diff.
- **Background agents.** Agents launched with `run_in_background` keep the prompt open until they report
  back and Claude has dealt with their reports, so "finished" means finished. Agents' own transcripts
  are followed, so the panel shows what each one is doing.
- **Retries and limits.** API retries (`529 Overloaded`, connection drops) show as `retrying 3/10`. A
  usage limit is reported with its reset time, the status bar shows it until then, and a second
  notification says when the limit has reset (`notifyOnLimitReset`). Errors come with what to do about
  them — for example "sign-in expired — run /login".
- **Richer notifications:** the conversation's title, files changed with `+/−` lines, agents, time
  spent waiting on you, and Claude's closing sentence; buttons for Review Changes and Open Claude.
  Errors and limits are always reported, however quickly they happen.
- Task progress from Claude's own task list (`3/7 tasks`) in the status bar, panel, tree and widget.
- Conversation titles (Claude Code's generated title, or your `/rename`) instead of bare folder names.
- The Sessions tree shows waits, errors, task lists, agents and changed files, with failed tool calls
  marked and a live timer on a tool call that is still running.
- The desktop widget shows the most urgent session first: amber and a flash when Claude needs you,
  retries, background agents, task progress, and for three minutes after a prompt ends its result
  (`Done · car — 4m 12s · 6 files +120 −14`). With VS Code closed it now detects questions and interrupts
  from the transcripts too.
- Tracking survives a window reload: the last few minutes of transcripts are replayed, so a prompt that
  was already running is picked up instead of being missed.

### Fixed

- Native notifications and the completion sound never worked on Windows. They were spawned with
  `detached: true` — the same DETACHED_PROCESS trap that broke the widget in 0.1.1: PowerShell exited in
  ~80ms without running the script.
- Interrupting a prompt left it "running" — spinner, climbing ETA — until the next prompt or 30 minutes
  later. About 6% of prompts are interrupted. They now end at once, as interrupted.
- Output tokens were counted about 1.8× too high: Claude Code writes one transcript entry per content
  block, each carrying the whole message's usage.
- Every VS Code start re-learned the same past prompts, piling duplicate records into the timing
  history; existing duplicates are dropped.
- A notification from a background task that Claude never answered (common when resuming a session)
  no longer shows as a running prompt.
- API errors that end a turn with a synthetic `stop_sequence` reply now end it instead of leaving it
  running.

### Changed

- The status bar item is always visible: between prompts it shows how the last one went (`✓ Claude done
  4m 12s`, or just `Claude`), so it is never mistaken for missing. It sits at the left end of the right-hand
  status bar group, where a crowded bar does not push it out.
- The sidebar's Widget panel is replaced by the Monitor panel; its button toggles the desktop widget as
  before. `Ctrl+Alt+Shift+M` focuses the Monitor panel, and clicking the status bar item opens it.

## 0.1.2

### Added

- The desktop widget button is a toggle: it opens the widget, closes it when it is already up, and
  relabels itself to match. The title bar icon and `Ctrl+Alt+M` toggle as well.

### Fixed

- The widget never opened from the button. The launch passed `detached: true`, which on Windows means
  DETACHED_PROCESS: the child gets no console and `powershell.exe` exits immediately with code 0.
  Every click spawned a process that died in about 70ms. It now launches without that flag, from the
  absolute System32 path, and still outlives VS Code.
- Placement ignored multi-monitor setups: the widget was positioned against the primary screen and a
  remembered position was only checked against that screen's bounds, so it could land on a monitor you
  were not looking at. It now follows the screen holding the mouse pointer, and a saved position is
  reused only when the whole window still fits on a screen that exists.
- The single-instance lock was an unnamed mutex that nothing could inspect. A widget that lingered
  without a window made every later launch fail silently. It is now a pid file: the owner can be
  checked, and a stale one is taken over.
- A failed launch is reported and logged rather than failing silently, and the extension notices when a
  newer build has been installed than the one the window is running, offering a reload.

## 0.1.1

### Added

- Native OS desktop notifications via `notificationTarget` (Windows toast, macOS notification centre,
  `notify-send`), visible while VS Code is minimised.
- Always-on-top desktop widget (`Claude Monitor: Open Desktop Widget`, `overlayAutoStart`): live
  elapsed time, ETA, progress bar and current step in a draggable window that outlives VS Code. When
  the extension is not running it reads the transcripts directly and still estimates, from completed
  turns in those transcripts plus a history file the extension publishes.
- `hooks/claude-stop-toast.ps1`: a standalone Claude Code Stop hook that notifies with no VS Code
  running at all.
- A Widget panel in the sidebar with real buttons, and an in-view row for opening the widget.
- Sessions view title bar buttons for the widget, timing stats and refresh, with the rest under the
  overflow menu. `Ctrl+Alt+M` opens the widget, `Ctrl+Alt+Shift+M` focuses the view.
- `Open Claude Widget.bat` for launching the widget with no VS Code involved.
- Extension icon.

### Fixed

- Estimates were learned against the project a session ended in but predicted from the project it
  started in, so a session that changed directory mid-turn learned into one pool and predicted from
  another. The project is now pinned to the turn: median error against real transcripts went from
  7.4x to 1.12x.
- The widget counted no tool calls and showed no current step, because the tool-use pattern did not
  allow for the id that sits between `"type"` and `"name"` in a real transcript.
- The widget showed no prompt text: prompt content is an array of blocks, not a string.
- Opening the widget while it was already running did nothing visible. It now comes to the front,
  moves to a known corner and flashes, and VS Code confirms the click in the status bar.
- The remembered widget position was discarded on every start, because `Set-Content -Encoding utf8`
  writes a byte-order mark that broke the coordinate parse.
- The widget's progress bar always read zero: `[Math]::Max(0, $double)` resolves to the `(int, int)`
  overload in PowerShell and truncated the fraction.
- The Stop hook took ~37 seconds on a large transcript because of `Get-Content -Tail`; it now reads
  the end of the file directly and finishes in about half a second.
- The status file is no longer filtered to the open workspace, so the widget can show a session that
  is running in another project.
- A failed widget launch is now reported, and every attempt is logged, instead of failing silently.

## 0.1.0

- Initial release.
- Tracks prompts for both the Claude Code VS Code extension and terminal sessions by tailing
  `~/.claude/projects/**/*.jsonl`.
- Status bar with elapsed time and estimated time to completion.
- Sessions view with per-turn step list (tool calls, targets, timings).
- Completion notification with duration, tool count and output tokens.
- Optional live progress notification and completion sound.
- Duration estimates learned from your own past prompts, per project, refined while a prompt runs.
