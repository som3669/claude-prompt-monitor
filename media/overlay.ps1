# Always-on-top desktop widget showing what Claude Code is doing right now.
#
# It runs as its own process and outlives VS Code. Two sources of truth, in order:
#   1. status.json, written every second by the VS Code extension (has the ETA, which needs the
#      extension's timing history).
#   2. If that file is missing or stale, the transcripts themselves, read directly. This is what keeps
#      the widget useful for terminal-only Claude Code with no VS Code running.
#
# Close it with the x in the corner, or Esc. Drag it anywhere; the position is remembered.

param(
	[string]$StatusPath = (Join-Path $env:TEMP 'claude-prompt-monitor\status.json'),
	[string]$ClaudeHome = (Join-Path $env:USERPROFILE '.claude')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# One widget is enough; a second launch just exits. Acquiring the mutex says more than the
# constructor's createdNew flag, which does not bind reliably through New-Object.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ClaudePromptMonitorOverlay')
$owned = $false
try {
	$owned = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
	# The previous widget was killed rather than closed; the mutex is ours now.
	$owned = $true
}
if (-not $owned) { exit 0 }

$stateDir = Split-Path $StatusPath -Parent
$positionPath = Join-Path $stateDir 'overlay-position.txt'

# Stale after this long, so a crashed or closed VS Code does not leave a frozen reading on screen.
$statusMaxAgeMs = 8000

# ---------------------------------------------------------------- data

function Format-Clock([double]$ms) {
	if ($ms -lt 0) { $ms = 0 }
	$total = [int][Math]::Round($ms / 1000)
	$minutes = [int][Math]::Floor($total / 60)
	$seconds = $total % 60
	return '{0}:{1:d2}' -f $minutes, $seconds
}

function Read-StatusFile {
	if (-not (Test-Path -LiteralPath $StatusPath)) { return $null }
	try {
		$raw = [System.IO.File]::ReadAllText($StatusPath)
		$status = $raw | ConvertFrom-Json
	} catch {
		return $null
	}
	$age = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$status.writtenAt)
	if ($age -gt $statusMaxAgeMs) { return $null }
	return $status
}

function Get-TailLines([string]$path, [int]$bytes) {
	try {
		$stream = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
		try {
			$take = [Math]::Min($bytes, $stream.Length)
			[void]$stream.Seek($stream.Length - $take, 'Begin')
			$buffer = New-Object byte[] $take
			[void]$stream.Read($buffer, 0, $take)
		} finally {
			$stream.Close()
		}
	} catch {
		return @()
	}
	$lines = [System.Text.Encoding]::UTF8.GetString($buffer).Split("`n")
	if ($take -lt (Get-Item -LiteralPath $path).Length -and $lines.Count -gt 1) {
		$lines = $lines[1..($lines.Count - 1)]
	}
	return $lines
}

# Durations of past prompts, used to estimate when the extension is not feeding us. Two sources:
# the history file the extension publishes, and any completed turns visible in the transcript tails
# this widget reads anyway. The second is what makes an estimate possible with VS Code never started.
$script:samples = @()

function Add-Sample([string]$project, [double]$durationMs, [int]$tools) {
	if ($durationMs -lt 1000) { return }
	$script:samples += [pscustomobject]@{ project = $project; durationMs = $durationMs; tools = $tools }
}

function Import-HistoryFile {
	$path = Join-Path (Split-Path $StatusPath -Parent) 'history.json'
	if (-not (Test-Path -LiteralPath $path)) { return }
	try {
		$records = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
	} catch {
		return
	}
	foreach ($record in $records) {
		$project = Split-Path ([string]$record.project) -Leaf
		Add-Sample $project ([double]$record.durationMs) ([int]$record.toolCount)
	}
}

function Get-Quantile($sorted, [double]$q) {
	if ($sorted.Count -eq 0) { return 0 }
	$position = ($sorted.Count - 1) * $q
	$lower = [int][Math]::Floor($position)
	$upper = [int][Math]::Ceiling($position)
	if ($lower -eq $upper) { return $sorted[$lower] }
	return $sorted[$lower] + ($sorted[$upper] - $sorted[$lower]) * ($position - $lower)
}

# Mirrors the extension's estimator: start from the median of comparable past prompts, then walk up
# the quantiles until one is still ahead of the time already spent.
function Get-Estimate([string]$project, [double]$elapsedMs, [int]$tools) {
	$scoped = @($script:samples | Where-Object { $_.project -eq $project })
	if ($scoped.Count -lt 3) { $scoped = $script:samples }
	$byWork = @($scoped | Where-Object { $_.tools -ge $tools })
	if ($byWork.Count -ge 3) { $scoped = $byWork }
	if ($scoped.Count -lt 3) {
		return [pscustomobject]@{ totalMs = 0; progress = 0; confident = $false }
	}

	$sorted = @($scoped | ForEach-Object { $_.durationMs } | Sort-Object)
	$total = 0
	foreach ($q in @(0.5, 0.75, 0.9, 0.98)) {
		$total = Get-Quantile $sorted $q
		if ($total -gt $elapsedMs * 1.05) { break }
	}
	$confident = $true
	if ($total -le $elapsedMs * 1.05) {
		$total = $elapsedMs * 1.25
		$confident = $false
	}
	$progress = 0
	if ($total -gt 0) { $progress = $elapsedMs / $total }
	if ($progress -gt 0.95) { $progress = 0.95 }
	return [pscustomobject]@{ totalMs = $total; progress = $progress; confident = $confident }
}

# Reads the transcripts directly: elapsed time, the current tool, the tool count, and — from the
# completed turns in the same tails — enough history to estimate without the extension running.
function Read-Transcripts {
	# Rebuilt from scratch every scan, otherwise the sample set grows without bound.
	$script:samples = @()
	Import-HistoryFile

	$projects = Join-Path $ClaudeHome 'projects'
	if (-not (Test-Path -LiteralPath $projects)) { return @() }

	$cutoff = (Get-Date).AddMinutes(-15)
	$files = Get-ChildItem -LiteralPath $projects -Filter '*.jsonl' -Recurse -File -ErrorAction SilentlyContinue |
		Where-Object { $_.LastWriteTime -gt $cutoff }

	$sessions = @()
	foreach ($file in $files) {
		$lines = Get-TailLines $file.FullName (1MB)
		if ($lines.Count -eq 0) { continue }

		# One forward pass: every human prompt opens a turn, end_turn closes it. Closed turns become
		# timing samples; a turn still open at the end of the file is what is running now.
		$startedAt = $null
		$project = 'Claude'
		$prompt = ''
		$tools = 0
		$lastStep = 'thinking'

		foreach ($line in $lines) {
			if ($line.Length -lt 2) { continue }

			if ($line.Contains('"type":"user"') -and $line.Contains('"kind":"human"')) {
				$startedAt = $null
				if ($line -match '"timestamp":"([^"]+)"') { $startedAt = [datetime]$matches[1] }
				$tools = 0
				$lastStep = 'thinking'
				if ($line -match '"cwd":"([^"]+)"') {
					$project = Split-Path ($matches[1] -replace '\\\\', '\') -Leaf
				}
				# The prompt is an array of content blocks, sometimes with several text blocks (an image
				# caption alongside the real instruction), so the longest one is the prompt.
				$prompt = ''
				foreach ($match in [regex]::Matches($line, '"text":"((?:[^"\\]|\\.){0,400})')) {
					if ($match.Groups[1].Value.Length -gt $prompt.Length) { $prompt = $match.Groups[1].Value }
				}
				if ($prompt -eq '' -and $line -match '"content":"((?:[^"\\]|\\.){0,400})') {
					$prompt = $matches[1]
				}
				$prompt = $prompt -replace '\\n', ' ' -replace '\\"', '"' -replace '\s+', ' '
				continue
			}

			if ($null -eq $startedAt) { continue }

			# {"type":"tool_use","id":"toolu_...","name":"Bash",...} - the id sits between the two keys.
			foreach ($match in [regex]::Matches($line, '"type":"tool_use"[^}]*?"name":"([^"]+)"')) {
				$tools++
				$lastStep = $match.Groups[1].Value
			}

			if ($line.Contains('"stop_reason":"end_turn"')) {
				$endedAt = $null
				if ($line -match '"timestamp":"([^"]+)"') { $endedAt = [datetime]$matches[1] }
				if ($null -ne $endedAt) {
					Add-Sample $project ($endedAt.ToUniversalTime() - $startedAt.ToUniversalTime()).TotalMilliseconds $tools
				}
				$startedAt = $null
			}
		}

		if ($null -eq $startedAt) { continue }

		$startedUtc = $startedAt.ToUniversalTime()
		$sessions += [pscustomobject]@{
			project   = $project
			prompt    = $prompt
			startedUtc = $startedUtc
			elapsedMs = ((Get-Date).ToUniversalTime() - $startedUtc).TotalMilliseconds
			etaMs     = 0
			progress  = 0
			confident = $false
			lastStep  = $lastStep
			tools     = $tools
		}
	}

	# Estimating last means every sample found above is already in hand.
	foreach ($session in $sessions) {
		$estimate = Get-Estimate $session.project $session.elapsedMs $session.tools
		$session.etaMs = $estimate.totalMs
		$session.progress = $estimate.progress
		$session.confident = $estimate.confident
	}
	return $sessions
}

# ---------------------------------------------------------------- window

$background = [System.Drawing.Color]::FromArgb(24, 24, 27)
$foreground = [System.Drawing.Color]::FromArgb(244, 244, 245)
$muted = [System.Drawing.Color]::FromArgb(161, 161, 170)
$accent = [System.Drawing.Color]::FromArgb(217, 119, 87)
$track = [System.Drawing.Color]::FromArgb(45, 45, 50)

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = $background
$form.Size = New-Object System.Drawing.Size(340, 104)
$form.StartPosition = 'Manual'

$workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
# Top-right by default: VS Code stacks its own notifications in the bottom-right corner.
$location = New-Object System.Drawing.Point(
	($workingArea.Right - $form.Width - 16),
	($workingArea.Top + 16)
)
if (Test-Path -LiteralPath $positionPath) {
	try {
		$saved = (Get-Content -LiteralPath $positionPath -Raw).Split(',')
		$candidate = New-Object System.Drawing.Point([int]$saved[0], [int]$saved[1])
		# Ignore a position from a monitor layout that no longer exists.
		if ($workingArea.Contains($candidate)) { $location = $candidate }
	} catch {
		# fall back to the default corner
	}
}
$form.Location = $location

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = $foreground
$titleLabel.BackColor = $background
$titleLabel.Location = New-Object System.Drawing.Point(14, 12)
$titleLabel.Size = New-Object System.Drawing.Size(286, 18)
$titleLabel.Text = 'Claude Prompt Monitor'
$form.Controls.Add($titleLabel)

$closeLabel = New-Object System.Windows.Forms.Label
$closeLabel.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$closeLabel.ForeColor = $muted
$closeLabel.BackColor = $background
$closeLabel.Text = [char]0x00D7
$closeLabel.TextAlign = 'MiddleCenter'
$closeLabel.Location = New-Object System.Drawing.Point(310, 10)
$closeLabel.Size = New-Object System.Drawing.Size(20, 20)
$closeLabel.Cursor = [System.Windows.Forms.Cursors]::Hand
$closeLabel.Add_Click({ $form.Close() })
$closeLabel.Add_MouseEnter({ $closeLabel.ForeColor = $foreground })
$closeLabel.Add_MouseLeave({ $closeLabel.ForeColor = $muted })
$form.Controls.Add($closeLabel)

$metaLabel = New-Object System.Windows.Forms.Label
$metaLabel.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$metaLabel.ForeColor = $muted
$metaLabel.BackColor = $background
$metaLabel.Location = New-Object System.Drawing.Point(14, 33)
$metaLabel.Size = New-Object System.Drawing.Size(316, 16)
$form.Controls.Add($metaLabel)

$trackPanel = New-Object System.Windows.Forms.Panel
$trackPanel.BackColor = $track
$trackPanel.Location = New-Object System.Drawing.Point(14, 56)
$trackPanel.Size = New-Object System.Drawing.Size(312, 4)
$form.Controls.Add($trackPanel)

$fillPanel = New-Object System.Windows.Forms.Panel
$fillPanel.BackColor = $accent
$fillPanel.Location = New-Object System.Drawing.Point(0, 0)
$fillPanel.Size = New-Object System.Drawing.Size(0, 4)
$trackPanel.Controls.Add($fillPanel)

$stepLabel = New-Object System.Windows.Forms.Label
$stepLabel.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$stepLabel.ForeColor = $muted
$stepLabel.BackColor = $background
$stepLabel.Location = New-Object System.Drawing.Point(14, 70)
$stepLabel.Size = New-Object System.Drawing.Size(316, 18)
$form.Controls.Add($stepLabel)

# Dragging: the window has no title bar to grab, so the whole surface moves it.
$script:dragging = $false
$script:dragOrigin = New-Object System.Drawing.Point(0, 0)
$startDrag = {
	param($sender, $e)
	if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
		$script:dragging = $true
		$script:dragOrigin = New-Object System.Drawing.Point($e.X, $e.Y)
	}
}
$doDrag = {
	param($sender, $e)
	if ($script:dragging) {
		$cursor = [System.Windows.Forms.Cursor]::Position
		$form.Location = New-Object System.Drawing.Point(
			($cursor.X - $script:dragOrigin.X),
			($cursor.Y - $script:dragOrigin.Y)
		)
	}
}
$endDrag = { $script:dragging = $false }

foreach ($control in @($form, $titleLabel, $metaLabel, $stepLabel)) {
	$control.Add_MouseDown($startDrag)
	$control.Add_MouseMove($doDrag)
	$control.Add_MouseUp($endDrag)
}

$form.KeyPreview = $true
$form.Add_KeyDown({
	param($sender, $e)
	if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Close() }
})

# ---------------------------------------------------------------- refresh

$script:cachedSessions = @()
$script:lastScanAt = [DateTime]::MinValue
$scanIntervalMs = 3000

function Update-Widget {
	$status = Read-StatusFile
	$sessions = @()
	$source = 'transcripts'
	if ($null -ne $status) {
		$sessions = @($status.sessions | Where-Object { $_ })
		$source = 'extension'
	}
	if ($sessions.Count -eq 0) {
		# Reading every transcript tail takes about a second, and this runs on the UI thread, so it
		# happens on a slower beat; in between, elapsed time and the estimate come off the cache.
		if (((Get-Date) - $script:lastScanAt).TotalMilliseconds -ge $scanIntervalMs) {
			$script:cachedSessions = @(Read-Transcripts)
			$script:lastScanAt = Get-Date
		}
		$now = (Get-Date).ToUniversalTime()
		foreach ($cached in $script:cachedSessions) {
			$cached.elapsedMs = ($now - $cached.startedUtc).TotalMilliseconds
			$estimate = Get-Estimate $cached.project $cached.elapsedMs $cached.tools
			$cached.etaMs = $estimate.totalMs
			$cached.progress = $estimate.progress
			$cached.confident = $estimate.confident
		}
		$sessions = $script:cachedSessions
		$source = 'transcripts'
	}

	if ($sessions.Count -eq 0) {
		$titleLabel.Text = 'Claude is idle'
		$metaLabel.Text = 'Waiting for a prompt'
		$stepLabel.Text = ''
		$fillPanel.Width = 0
		return
	}

	# The oldest running prompt is the one being waited on.
	$session = $sessions | Sort-Object -Property elapsedMs -Descending | Select-Object -First 1
	$extra = ''
	if ($sessions.Count -gt 1) { $extra = ' +{0} more' -f ($sessions.Count - 1) }

	$project = $session.project
	if ([string]::IsNullOrWhiteSpace($project)) { $project = 'Claude' }
	$titleLabel.Text = '{0}{1}' -f $project, $extra

	$elapsed = Format-Clock $session.elapsedMs
	if ($session.etaMs -gt 0) {
		$suffix = ''
		if (-not $session.confident) { $suffix = '?' }
		$metaLabel.Text = '{0} / ~{1}{2}   {3} tools' -f $elapsed, (Format-Clock $session.etaMs), $suffix, $session.tools
		# Clamped by hand: [Math]::Max(0, $double) resolves to the (int, int) overload and truncates.
		$fraction = [double]$session.progress
		if ($fraction -lt 0) { $fraction = 0 }
		if ($fraction -gt 1) { $fraction = 1 }
		$fillPanel.Width = [int]($trackPanel.Width * $fraction)
	} else {
		$note = ''
		if ($source -eq 'transcripts') { $note = '   (no estimate without VS Code)' }
		$metaLabel.Text = '{0}   {1} tools{2}' -f $elapsed, $session.tools, $note
		$fillPanel.Width = 0
	}

	$step = $session.lastStep
	if ([string]::IsNullOrWhiteSpace($step)) { $step = 'thinking' }
	$prompt = [string]$session.prompt
	if ($prompt.Length -gt 46) { $prompt = $prompt.Substring(0, 45) + [char]0x2026 }
	if ([string]::IsNullOrWhiteSpace($prompt)) {
		$stepLabel.Text = $step
	} else {
		$stepLabel.Text = '{0} - {1}' -f $step, $prompt
	}
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
	try { Update-Widget } catch { }
})

$form.Add_Shown({
	$timer.Start()
	try { Update-Widget } catch { }
})

$form.Add_FormClosing({
	$timer.Stop()
	try {
		if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
		Set-Content -LiteralPath $positionPath -Value ('{0},{1}' -f $form.Location.X, $form.Location.Y) -Encoding utf8
	} catch { }
})

[void][System.Windows.Forms.Application]::Run($form)
$mutex.ReleaseMutex()
