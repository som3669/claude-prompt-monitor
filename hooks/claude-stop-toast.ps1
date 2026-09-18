# Claude Code Stop hook: shows a Windows desktop notification when a prompt finishes.
#
# This is self-contained on purpose — copy it anywhere (for example ~/.claude/hooks/) and point a
# Stop hook at it. It needs no VS Code and no extension; it works for terminal Claude Code sessions
# with the editor closed.
#
# Register it in ~/.claude/settings.json:
#
#   "hooks": {
#     "Stop": [
#       { "matcher": "", "hooks": [
#         { "type": "command",
#           "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\path\\to\\claude-stop-toast.ps1\"" }
#       ]}
#     ]
#   }
#
# A Stop hook must stay quiet and exit 0, otherwise Claude Code treats its output as feedback.

$ErrorActionPreference = 'Stop'

# Claude Code passes the hook payload as JSON on stdin.
$raw = [Console]::In.ReadToEnd()
try {
	$payload = $raw | ConvertFrom-Json
} catch {
	exit 0
}

$transcript = $payload.transcript_path
$cwd = $payload.cwd
$project = 'Claude'
if (-not [string]::IsNullOrWhiteSpace($cwd)) { $project = Split-Path $cwd -Leaf }

# Prompts shorter than this finish while you are still looking at the screen.
$minimumSeconds = 15

$parts = @()

if (-not [string]::IsNullOrWhiteSpace($transcript) -and (Test-Path $transcript)) {
	# A Stop hook blocks Claude Code while it runs, so this has to be quick. Transcripts reach tens of
	# megabytes with very long lines: `Get-Content -Tail 3000` takes ~37 seconds on one of those, while
	# reading the last few megabytes straight off the end takes ~50ms. The scan is then plain string
	# work, and no JSON is parsed at all.
	$lines = @()
	try {
		$stream = [System.IO.File]::Open($transcript, 'Open', 'Read', 'ReadWrite')
		try {
			$take = [Math]::Min(4MB, $stream.Length)
			[void]$stream.Seek($stream.Length - $take, 'Begin')
			$buffer = New-Object byte[] $take
			[void]$stream.Read($buffer, 0, $take)
		} finally {
			$stream.Close()
		}
		$lines = [System.Text.Encoding]::UTF8.GetString($buffer).Split("`n")
		# A partial read starts mid-line; that fragment is not usable.
		if ($take -lt (Get-Item -LiteralPath $transcript).Length -and $lines.Count -gt 0) {
			$lines = $lines[1..($lines.Count - 1)]
		}
	} catch {
		exit 0
	}
	$startIndex = -1
	for ($i = $lines.Count - 1; $i -ge 0; $i--) {
		$line = $lines[$i]
		if ($line.Contains('"type":"user"') -and $line.Contains('"kind":"human"')) {
			$startIndex = $i
			break
		}
	}

	if ($startIndex -ge 0) {
		$startedAt = $null
		if ($lines[$startIndex] -match '"timestamp":"([^"]+)"') { $startedAt = $matches[1] }

		$tools = 0
		for ($i = $startIndex + 1; $i -lt $lines.Count; $i++) {
			$tools += ([regex]::Matches($lines[$i], '"type":"tool_use"')).Count
		}

		if ($null -ne $startedAt) {
			$elapsed = (Get-Date).ToUniversalTime() - ([datetime]$startedAt).ToUniversalTime()
			$seconds = [int]$elapsed.TotalSeconds
			if ($seconds -lt $minimumSeconds) { exit 0 }

			if ($elapsed.TotalHours -ge 1) {
				$parts += '{0}h {1:d2}m' -f [int]$elapsed.TotalHours, $elapsed.Minutes
			} elseif ($elapsed.TotalMinutes -ge 1) {
				$parts += '{0}m {1:d2}s' -f [int]$elapsed.TotalMinutes, $elapsed.Seconds
			} else {
				$parts += '{0}s' -f $seconds
			}
		}

		$callWord = 'calls'
		if ($tools -eq 1) { $callWord = 'call' }
		$parts += "$tools tool $callWord"
	}
}

$title = "Claude finished - $project"
$body = $parts -join ' - '
if ([string]::IsNullOrWhiteSpace($body)) { $body = 'Prompt complete.' }

try {
	[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
	[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

	$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
		[Windows.UI.Notifications.ToastTemplateType]::ToastText02
	)
	$nodes = $template.GetElementsByTagName('text')
	[void]$nodes.Item(0).AppendChild($template.CreateTextNode($title))
	[void]$nodes.Item(1).AppendChild($template.CreateTextNode($body))

	$toast = New-Object Windows.UI.Notifications.ToastNotification $template
	$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
	[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
	# Never fail the hook over a notification.
}

exit 0
