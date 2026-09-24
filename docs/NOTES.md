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
