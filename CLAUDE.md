# Claude Prompt Monitor

VS Code extension that tracks every Claude Code prompt (VS Code extension and terminal sessions, any cwd): live progress, elapsed time, ETA learned from past prompts, completion notifications, and an always-on-top desktop widget that outlives VS Code.

- Id `somshrestha.somshrestha-claude-prompt-monitor`, MIT. Own repo: https://github.com/som3669/claude-prompt-monitor (not the parent vs-code-extenstion-setup repo).
- Current: v0.1.2 (released 2026-09-21; tags v0.1.0, v0.1.1, v0.1.2). Distributed as GitHub release `.vsix` only, not on the Marketplace.
- Durable dev notes also live in `docs/NOTES.md` (travels with a clone). Keep both in sync.

## Stack / how it works
TypeScript, no runtime deps. Tails `~/.claude/projects/**/*.jsonl` (setting `claudeHome`); nothing is sent anywhere, Claude Code is not wrapped.
Publishes `status.json`, `history.json`, `overlay.pid` to `%TEMP%\claude-prompt-monitor\` for the widget. The widget (`media/overlay.ps1`) can also read transcripts itself when VS Code is closed.

## Key files
- `src/extension.ts` entry; `transcriptWatcher.ts`, `turnTracker.ts`, `estimator.ts` (ETA), `statusBar.ts`, `notifier.ts`, `sessionsView.ts`, `controlsView.ts` (Widget webview panel), `statusFile.ts` (status/history files, widget spawn + pid lock)
- `media/overlay.ps1` desktop widget; `media/toast.ps1` native Windows toast
- `hooks/claude-stop-toast.ps1` standalone Claude Code Stop hook (no VS Code needed)
- `Open Claude Widget.bat` launches the widget without VS Code
- Keys: `Ctrl+Alt+M` toggle widget, `Ctrl+Alt+Shift+M` show Sessions view. `notificationTarget` = editor|native|both.

## Commands
```
npm install
npm run compile                 # tsc
npm run package                 # npx @vscode/vsce@2.32.0 package -> .vsix
code --install-extension somshrestha-claude-prompt-monitor-<ver>.vsix --force
```
Then reload the VS Code window (mandatory, see ../CLAUDE.md). F5 runs an Extension Development Host.

## Release (as done for 0.1.0-0.1.2)
1. Ask the user before bumping `version` in `package.json`.
2. Move CHANGELOG `Unreleased` to the new version.
3. `npm run compile && npm run package`
4. Commit, push, `git tag -a vX.Y.Z -m "vX.Y.Z"`, push tag.
5. `gh release create vX.Y.Z <file>.vsix --title ... --notes ...` (`.vsix` is gitignored; the release asset is the install path).
Delete the previous version's `.vsix` from the folder after release.

## Constraints
- vsce pinned to 2.32.0: latest vsce needs Node 22+ and crashes on this machine's Node 20 (`TypeError [ERR_INVALID_ARG_VALUE]` from `styleText`).
- Not on Marketplace: needs publisher account `somshrestha` + Azure DevOps PAT, and the icon reuses VS Code and Claude marks (trademark risk for a public listing).
- Notification text goes to the OS via env vars/argv, never a shell string.

## History / gotchas
- 2026-09-18 built; 0.1.0 released same session. 0.1.1: native notifications, desktop widget, Stop hook, estimator fix (project pinned to the turn: median error 7.4x -> 1.12x).
- 0.1.2 (2026-09-21): widget never opened because spawn used `detached: true` (DETACHED_PROCESS, powershell exits 0 in ~70ms). Now `windowsHide: true`, `stdio: 'ignore'`, absolute System32 path. Button became a toggle; multi-monitor placement follows the mouse screen; mutex replaced by pid file; extension detects a stale build and offers reload.
- PowerShell 5.1 traps hit here: `[Math]::Max(0,$double)` truncates to int; `Set-Content -Encoding utf8` writes a BOM (use `[IO.File]::WriteAllText`); `Get-Content -Tail` took ~37s on large transcripts (seek with FileStream); `New-Object Mutex(..., [ref]$created)` does not bind `createdNew`.
- Verify the widget via EnumWindows/GetWindowRect, not by grepping process command lines.

## Open items
- Marketplace publish not done (needs PAT + icon decision).
