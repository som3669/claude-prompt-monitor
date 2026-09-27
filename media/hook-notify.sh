#!/bin/sh
# Claude Code Notification hook for Claude Prompt Monitor (macOS / Linux).
#
# Appends the hook payload as one JSON line to the monitor's events file, so the VS Code extension
# knows the moment Claude Code shows a permission prompt or waits for input. Prints nothing and
# always exits 0, so it can never block or fail a session.

out="${1:-${TMPDIR:-/tmp}/claude-prompt-monitor/events.jsonl}"
mkdir -p "$(dirname "$out")" 2>/dev/null
payload=$(tr -d '\r\n')
if [ -n "$payload" ]; then
	printf '{"at":%s000,"event":%s}\n' "$(date +%s)" "$payload" >> "$out" 2>/dev/null
fi
exit 0
