# Claude Code Notification hook for Claude Prompt Monitor.
#
# Claude Code runs this when it shows a permission prompt or waits for input. It appends the hook
# payload as one JSON line to the monitor's events file, which the VS Code extension watches, so the
# extension knows the exact moment Claude is blocked on you. The transcript records nothing until you
# answer, so this is the only exact signal for permission prompts.
#
# It prints nothing and always exits 0, so it can never block or fail a session. Installed and removed
# by the "Claude Monitor: Install Permission Alert Hook" command; safe to delete by hand as well.

param(
	[string]$Out = (Join-Path $env:TEMP 'claude-prompt-monitor\events.jsonl')
)

try {
	# Read stdin as UTF-8 bytes: the console input encoding is not UTF-8 by default and would mangle
	# non-ASCII text in the message.
	$stdin = [Console]::OpenStandardInput()
	$reader = New-Object System.IO.StreamReader($stdin, (New-Object System.Text.UTF8Encoding($false)))
	$raw = $reader.ReadToEnd()
	$reader.Close()
	if (-not [string]::IsNullOrWhiteSpace($raw)) {
		# JSON strings cannot hold raw line breaks, so collapsing them keeps the payload valid.
		$line = ($raw -replace "[`r`n]+", ' ').Trim()
		$dir = Split-Path -Parent $Out
		if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
		$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
		$record = '{"at":' + $stamp + ',"event":' + $line + '}' + "`n"
		[System.IO.File]::AppendAllText($Out, $record, (New-Object System.Text.UTF8Encoding($false)))
	}
} catch {
	# nothing useful to report, and a hook must stay quiet
}
exit 0
