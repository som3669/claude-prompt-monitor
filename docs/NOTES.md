# Development notes

Things that are easy to lose and expensive to rediscover. The README covers what the extension does;
this covers how to work on it.

## Getting set up on a new machine

```
git clone https://github.com/som3669/claude-prompt-monitor
cd claude-prompt-monitor
npm install
npm run compile
npm run package                 # produces the .vsix
code --install-extension somshrestha-claude-prompt-monitor-<version>.vsix --force
```

Then **reload the VS Code window**. See below — this is not optional.

`F5` in this folder runs the extension in an Extension Development Host instead, which reloads on its
own and is the faster loop while iterating.

## A window runs the build it started with

Installing a new `.vsix` replaces the files on disk, but an already-open VS Code window keeps executing
the JavaScript it loaded at startup, indefinitely and with no warning. A fix can look like it did
nothing, through any number of installs.

This cost hours during the 0.1.1 → 0.1.2 work: every "the button still does nothing" report traced back
to a window running older code. Confirm it by comparing the extension host start time in

```
%APPDATA%\Code\logs\<timestamp>\window*\exthost\exthost.log
```

with the mtime of the installed `out/*.js`. If the host started first, the window is stale.

Since 0.1.2 the extension checks for this itself and offers a reload, but the check only runs once a
window is on that build.

## Do not spawn GUI child processes with `detached: true`

Node maps `detached` to `DETACHED_PROCESS` on Windows, so the child gets no console and
`powershell.exe` exits immediately with code 0 — a launch that fails in complete silence. That was the
0.1.2 headline bug: every click spawned a widget process that died in about 70ms.

Spawn with `windowsHide: true` and `stdio: 'ignore'` and no `detached`. The child still outlives the
parent, which is what the widget needs.

The same flag also broke the native toast and the completion sound, unnoticed until 2026-09-27: a probe
spawned exactly as `notifier.ts` did exited after 77ms and never ran its script, while the same spawn
without `detached` ran to completion. Any PowerShell child, GUI or not, needs the plain spawn. Use
`powershellPath()` from `src/platform.ts` for the absolute path.

## Testing

`npm test` compiles, then runs `test/scenarios.js` (hand-written cases for paths real transcripts rarely
hit: hook permission waits, plan approval, background hand-backs, usage limits) and `test/replay.js`,
which replays every transcript on the machine through the tracker and prints a summary. `node
test/replay.js <session-id>` traces one session turn by turn. Both load `test/vscode-stub.js`, a
stand-in for the `vscode` module, so they run under plain Node.

When changing the state machine, compare the replay summary before and after. On this machine
(2026-09-27, ~2,600 human turns) it was: done 2427, interrupted 165, error 56, limited 12, abandoned 20;
104 question waits, median 46s; 16 turns held open for background agents.

## Transcript facts the tracker relies on

Checked against the real transcripts in September 2026 (Claude Code 2.1.2xx). Re-check them when a
Claude Code update makes the numbers above move.

- **Interrupts** are a `user` entry whose text starts `[Request interrupted by user` (`… for tool use]`
  when a tool call was rejected). About 6% of prompts end this way. The same marker also appears
  *after* `end_turn` when the next message cancels a still-running Stop hook, so a marker with no open
  turn, or during the background phase, is not an interrupt.
- **Waiting on the user**: `AskUserQuestion` and `ExitPlanMode` tool calls stay open until the answer
  arrives as their `tool_result` (median 46s, p90 6 min, max 35 min — so a waiting turn must never be
  swept as stale). A permission prompt writes nothing until answered; only the Notification hook
  (`notification_type: permission_prompt`) reports it. The hook does fire for the VS Code extension.
- **Usage limits** are an assistant entry with `isApiErrorMessage: true`, `error: "rate_limit"` and
  `quotaLimits.resetsAt` (Unix seconds). Other API failures are `isApiErrorMessage` with the reason in the
  text ("Failed to authenticate…", "529 Overloaded", "Prompt is too long"). Retries in progress are
  `system` entries with `subtype: "api_error"`, `retryAttempt`, `maxRetries`, `retryInMs`.
- **One entry per content block**: an assistant message with thinking + text + tool call is written as
  three entries with the same `message.id`, each carrying the whole message's `usage`. Count usage once
  per id (0.1.x counted it ~1.8× over).
- **Agents** write their own transcripts to `<project>/<session>/subagents/agent-<id>.jsonl`, entries
  `isSidechain: true` with `agentId`, plus `agent-<id>.meta.json` (`agentType`, `description`,
  `toolUseId`, `requestShape: "background"`). A background launch returns at once
  (`toolUseResult.isAsync: true`, `agentId`); the agent's transcript ends with its own `end_turn`, and
  its report reaches the parent ~30s later as a `user` entry with `origin.kind: "peer"` containing
  `<agent-message from="<agentId>">` — minutes later behind a slow Stop hook. Some reports never
  arrive, hence the 3-minute grace in `HANDBACK_GRACE_MS`.
- **Background tasks** report back as `origin.kind: "task-notification"` with `<task-id>`,
  `<status>`, `<summary>`. On resume, stale ones are often folded into the next prompt and never
  answered, so a notification only becomes a turn when Claude replies to it.
- **File history**: before Claude's first edit of a file in a turn, Claude Code writes a
  `file-history-delta` entry (no `sessionId`; take it from the file name) whose `backup.backupFileName`
  names the pre-edit copy in `~/.claude/file-history/<session>/`; `null` means the file was new. The
  backup is the true before-state. `toolUseResult.originalFile` on Edit results is capped at 10,000
  characters (empty for big files), so it is not.
- `ai-title` / `custom-title` entries carry the conversation's title; `queue-operation` entries
  (enqueue/dequeue/remove) track prompts typed while Claude was busy.

## Verifying the widget

Counting processes by command line is unreliable in two ways, and both produced false results while
debugging:

- A filter such as `CommandLine -like '*overlay.ps1*'` matches the *querying* PowerShell's own command
  line. It counts itself, and a `Stop-Process` over the results kills the checker. Always exclude
  `$PID`.
- A process existing does not mean a window is on screen, and the window may be on another monitor.

Check the window itself — `EnumWindows` plus `GetWindowRect` and the `WS_EX_TOPMOST` style — and take
the coordinates seriously against the current monitor layout.

## PowerShell 5.1 traps hit by this codebase

- `[Math]::Max(0, $double)` resolves to the `(int, int)` overload and truncates. Clamp by hand.
- `Set-Content -Encoding utf8` writes a BOM, which broke reading a saved window position back.
  `[System.IO.File]::WriteAllText` does not.
- `Get-Content -Tail` on a large transcript took ~37 seconds; seeking to the end of the file with a
  `FileStream` takes ~50ms.
- `New-Object Mutex($true, $name, [ref]$created)` does not bind the `createdNew` out-parameter, so the
  single-instance check silently failed. The widget now uses a pid file, which can also be inspected
  and taken over when stale.

## Releasing

`npm run package` pins `@vscode/vsce@2.32.0` deliberately: newer vsce needs Node 22+ and crashes on
Node 20 with `TypeError [ERR_INVALID_ARG_VALUE]` from `styleText`.

1. Bump `version` in `package.json`.
2. Move the CHANGELOG section from Unreleased to the new version.
3. `npm run compile && npm run package`
4. Commit, push, `git tag -a vX.Y.Z -m "vX.Y.Z"`, push the tag.
5. `gh release create vX.Y.Z <file>.vsix --title … --notes …`

The `.vsix` is gitignored, so the release asset is the only way people install it.

Not published to the VS Code Marketplace. That needs a publisher account for the id `somshrestha` and
an Azure DevOps PAT, and the icon reuses the VS Code and Claude marks — a trademark question for a
public listing, though not for a GitHub release.
