# Change Log

## Unreleased

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
