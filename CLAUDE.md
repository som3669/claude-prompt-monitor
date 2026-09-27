# Claude Prompt Monitor

VS Code extension that tracks every Claude Code prompt (VS Code extension and terminal sessions, any cwd): live progress, ETA learned from past prompts, when Claude is waiting on you (questions, plan approval, permission prompts via an opt-in hook), background agents, retries and usage limits, completion notifications with what changed, per-prompt diffs, a Monitor panel, and an always-on-top desktop widget that outlives VS Code.

- Id `somshrestha.somshrestha-claude-prompt-monitor`, MIT. Own repo: https://github.com/som3669/claude-prompt-monitor (not the parent vs-code-extenstion-setup repo).
- Current: v0.1.3 (released 2026-09-27; tags v0.1.0 to v0.1.3). Distributed as GitHub release `.vsix` only, not on the Marketplace.
- v0.1.3 (2026-09-27, version chosen by Som): the Monitor panel, needs-you states, hook, agents, per-prompt diffs, always-visible status bar item, and fixes for native toasts, interrupts and token counts.
- Durable dev notes also live in `docs/NOTES.md` (travels with a clone). Keep both in sync.

## Stack / how it works
TypeScript, no runtime deps. Tails `~/.claude/projects/**/*.jsonl` (setting `claudeHome`); nothing is sent anywhere, Claude Code is not wrapped.
Publishes `status.json`, `history.json`, `overlay.pid` to `%TEMP%\claude-prompt-monitor\` for the widget. The widget (`media/overlay.ps1`) can also read transcripts itself when VS Code is closed.

## Key files
- `src/extension.ts` entry and command wiring
- `turnTracker.ts` the state machine: turns, waits, retries, limits, interrupts, background agents, file changes, replay flag. `transcriptWatcher.ts` tails transcripts + busy sessions' `subagents/` and replays recent tails on start
- `present.ts` shared presentation (live state, urgency order, headline, error advice, summaries); `estimator.ts` ETA on active time (waits excluded)
- `statusBar.ts`, `notifier.ts`, `sessionsView.ts` (tree), `dashboardView.ts` + `media/dashboard.{js,css}` (Monitor webview), `changes.ts` (per-prompt diffs from file-history backups), `recentStore.ts` (Recent list), `hookBridge.ts` (Notification hook install + events tail), `statusFile.ts` (status v2/history files, widget spawn + pid lock), `platform.ts`
- `media/overlay.ps1` desktop widget; `media/toast.ps1` native Windows toast; `media/hook-notify.{ps1,sh}` the Notification hook script (copied to `~/.claude/hooks/claude-prompt-monitor-hook.*` on install)
- `hooks/claude-stop-toast.ps1` standalone Claude Code Stop hook (no VS Code needed)
- `Open Claude Widget.bat` launches the widget without VS Code
- Keys: `Ctrl+Alt+M` toggle widget, `Ctrl+Alt+Shift+M` focus the Monitor panel. `notificationTarget` = editor|native|both.
- `docs/concept/`: the concept design (2026-09-27) as canvas sources (`*.dc.html`, `canvas.json`) plus `index.html`, a static preview of all boards; excluded from the `.vsix`. Online canvas: https://claude.ai/artifact/NQKVRx2vNm1CPQ4gAoYnah (private; only the overview board was published before the Artifact tool went away).
- `test/`: `npm test` = compile + `scenarios.js` + `replay.js` (replays this machine's transcripts; `node test/replay.js <session>` traces one). `vscode-stub.js` lets them run in plain Node.

## Commands
```
npm install
npm run compile                 # tsc
npm test                        # compile + scenario tests + replay of local transcripts
npm run package                 # npx @vscode/vsce@2.32.0 package -> .vsix
code --install-extension somshrestha-claude-prompt-monitor-<ver>.vsix --profile Som --force
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
- 0.1.3 (2026-09-27): surveyed ~2,600 real turns to build the new state machine; `docs/NOTES.md` "Transcript facts" lists the shapes it relies on. Found and fixed: native toast + sound never ran on Windows (`detached: true` again), interrupts left turns running, tokens double-counted, duplicate history on every start.
- The Notification hook edits `~/.claude/settings.json`: never rewrite it if it fails to parse; backup goes to `settings.json.before-claude-prompt-monitor`.

## Open items
- Marketplace publish not done (needs PAT + icon decision).
