# Change Log

## 0.1.0

- Initial release.
- Tracks prompts for both the Claude Code VS Code extension and terminal sessions by tailing
  `~/.claude/projects/**/*.jsonl`.
- Status bar with elapsed time and estimated time to completion.
- Sessions view with per-turn step list (tool calls, targets, timings).
- Completion notification with duration, tool count and output tokens.
- Optional live progress notification and completion sound.
- Duration estimates learned from your own past prompts, per project, refined while a prompt runs.
- `notificationTarget` setting: native OS desktop notifications (Windows toast, macOS notification
  centre, `notify-send`) that are visible while VS Code is minimised.
- `hooks/claude-stop-toast.ps1`: a standalone Claude Code Stop hook that notifies with no VS Code
  running at all.
- Always-on-top desktop widget (`Claude Monitor: Open Desktop Widget`, `overlayAutoStart`): live
  elapsed time, ETA, progress bar and current step in a draggable window that outlives VS Code and
  falls back to reading transcripts directly when the extension is not running — including the
  estimate, which it derives from completed turns in the transcripts and from a history file the
  extension publishes.
