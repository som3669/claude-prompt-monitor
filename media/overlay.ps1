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

$stateDir = Split-Path $StatusPath -Parent
$positionPath = Join-Path $stateDir 'overlay-position.txt'
$showRequestPath = Join-Path $stateDir 'overlay-show.request'
$closeRequestPath = Join-Path $stateDir 'overlay-close.request'
$pidPath = Join-Path $stateDir 'overlay.pid'

# Single instance through a pid file rather than a mutex. A mutex cannot be inspected: when a widget
# lingered without a window, every later launch silently took the "already running" path with no way
# to see why. A pid can be checked, and a stale one can be taken over.
function Test-WidgetAlive {
	if (-not (Test-Path -LiteralPath $pidPath)) { return $false }
	try {
		$recorded = [int]((Get-Content -LiteralPath $pidPath -Raw).Trim([char]0xFEFF, ' ', "`r", "`n"))
	} catch {
		return $false
	}
	$process = Get-Process -Id $recorded -ErrorAction SilentlyContinue
	if ($null -eq $process) { return $false }
	return $process.ProcessName -eq 'powershell'
}

$owned = -not (Test-WidgetAlive)

if (-not $owned) {
	# Already running. Rather than exit silently - which makes the button look dead - leave a note the
	# running widget picks up on its next tick, so it surfaces and moves back into view.
	try {
		if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
		[System.IO.File]::WriteAllText($showRequestPath, [DateTime]::UtcNow.ToString('o'))
	} catch {
		# nothing useful left to try
	}
	exit 0
}
try {
	Remove-Item -LiteralPath $showRequestPath -Force -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $closeRequestPath -Force -ErrorAction SilentlyContinue
	if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
	[System.IO.File]::WriteAllText($pidPath, $PID.ToString())
} catch { }

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
	# Agents write their own transcripts under <session>\subagents; they never open a turn of their own.
	$files = Get-ChildItem -LiteralPath $projects -Filter '*.jsonl' -Recurse -File -ErrorAction SilentlyContinue |
		Where-Object { $_.LastWriteTime -gt $cutoff -and $_.FullName -notmatch '\\subagents\\' }

	$sessions = @()
	foreach ($file in $files) {
		$lines = Get-TailLines $file.FullName (1MB)
		if ($lines.Count -eq 0) { continue }

		# One forward pass: every human prompt opens a turn, end_turn closes it - and so do an interrupt,
		# an API error or a usage limit. Closed turns become timing samples; a turn still open at the end
		# of the file is what is running now.
		$startedAt = $null
		$project = 'Claude'
		$prompt = ''
		$tools = 0
		$lastStep = 'thinking'
		$waiting = $false
		$question = ''

		foreach ($line in $lines) {
			if ($line.Length -lt 2) { continue }

			if ($line.Contains('"type":"user"') -and $line.Contains('"kind":"human"')) {
				$startedAt = $null
				if ($line -match '"timestamp":"([^"]+)"') { $startedAt = [datetime]$matches[1] }
				$tools = 0
				$lastStep = 'thinking'
				$waiting = $false
				$question = ''
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

			# The user pressed stop. (After end_turn the same marker comes from a cancelled Stop hook, but
			# by then no turn is open.)
			if ($line.Contains('"type":"user"') -and $line.Contains('[Request interrupted by user')) {
				$startedAt = $null
				continue
			}
			# An API error or a usage limit ends the turn: Claude is not coming back to it on its own.
			if ($line.Contains('"isApiErrorMessage":true') -or
				($line.Contains('"model":"<synthetic>"') -and $line.Contains('"stop_reason":"stop_sequence"'))) {
				$startedAt = $null
				continue
			}
			if ($line.Contains('"isSidechain":true')) { continue }

			# The answer to a question arrives as the next tool result.
			if ($waiting -and $line.Contains('"type":"tool_result"')) {
				$waiting = $false
				$question = ''
			}

			# {"type":"tool_use","id":"toolu_...","name":"Bash",...} - the id sits between the two keys.
			foreach ($match in [regex]::Matches($line, '"type":"tool_use"[^}]*?"name":"([^"]+)"')) {
				$tools++
				$lastStep = $match.Groups[1].Value
				if ($lastStep -eq 'AskUserQuestion' -or $lastStep -eq 'ExitPlanMode') {
					$waiting = $true
					$question = 'A plan is ready for your approval'
					if ($line -match '"question":"((?:[^"\\]|\\.){0,160})') {
						$question = $matches[1] -replace '\\n', ' ' -replace '\\"', '"'
					}
				}
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
		$state = 'working'
		if ($waiting) { $state = 'waiting' }
		$sessions += [pscustomobject]@{
			project    = $project
			title      = ''
			prompt     = $prompt
			state      = $state
			waitDetail = $question
			startedUtc = $startedUtc
			elapsedMs  = ((Get-Date).ToUniversalTime() - $startedUtc).TotalMilliseconds
			etaMs      = 0
			progress   = 0
			confident  = $false
			lastStep   = $lastStep
			stepDetail = ''
			tools      = $tools
			tasksDone  = 0
			tasksTotal = 0
			agents     = 0
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
# State colours. Each is always paired with words on the widget, never the only signal.
$waitColor = [System.Drawing.Color]::FromArgb(234, 179, 8)
$doneColor = [System.Drawing.Color]::FromArgb(34, 197, 94)
$failColor = [System.Drawing.Color]::FromArgb(239, 68, 68)
$agentColor = [System.Drawing.Color]::FromArgb(125, 140, 170)
$dot = [char]0x00B7
$minus = [char]0x2212
$ellipsis = [char]0x2026

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = $background
$form.Size = New-Object System.Drawing.Size(340, 104)
$form.StartPosition = 'Manual'

# With several monitors the primary one is often not the one being looked at, so the widget follows
# the screen holding the mouse pointer.
function Get-TargetArea {
	$screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
	if ($null -eq $screen) { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
	return $screen.WorkingArea
}

function Get-DefaultLocation {
	$area = Get-TargetArea
	# Top-right: VS Code stacks its own notifications in the bottom-right corner.
	return New-Object System.Drawing.Point(
		($area.Right - $form.Width - 16),
		($area.Top + 16)
	)
}

# A remembered spot is only usable if the whole window still lands on a screen that exists: monitors
# get unplugged, and a window placed off the desktop is indistinguishable from one that never opened.
function Test-OnScreen([System.Drawing.Rectangle]$bounds) {
	foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
		if ($screen.WorkingArea.Contains($bounds)) { return $true }
	}
	return $false
}

$location = Get-DefaultLocation
if (Test-Path -LiteralPath $positionPath) {
	try {
		# Trim any byte-order mark left by older versions, which otherwise breaks the cast.
		$saved = (Get-Content -LiteralPath $positionPath -Raw).Trim([char]0xFEFF, ' ', "`r", "`n").Split(',')
		$candidate = New-Object System.Drawing.Rectangle ([int]$saved[0]), ([int]$saved[1]), $form.Width, $form.Height
		if (Test-OnScreen $candidate) { $location = New-Object System.Drawing.Point $candidate.X, $candidate.Y }
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

# A strip down the left edge in the state's colour, readable from across the room.
$stripePanel = New-Object System.Windows.Forms.Panel
$stripePanel.BackColor = $track
$stripePanel.Location = New-Object System.Drawing.Point(0, 0)
$stripePanel.Size = New-Object System.Drawing.Size(3, $form.Height)
$form.Controls.Add($stripePanel)

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
$script:flashTicks = 0
$script:flashColor = $accent
$script:lastWaitKey = ''
$scanIntervalMs = 3000

function Format-Duration([double]$ms) {
	if ($ms -lt 0) { $ms = 0 }
	$total = [int][Math]::Round($ms / 1000)
	$hours = [int][Math]::Floor($total / 3600)
	$minutes = [int][Math]::Floor(($total % 3600) / 60)
	$seconds = $total % 60
	if ($hours -gt 0) { return '{0}h {1:d2}m' -f $hours, $minutes }
	if ($minutes -gt 0) { return '{0}m {1:d2}s' -f $minutes, $seconds }
	return '{0}s' -f $seconds
}

function Limit-Text([string]$text, [int]$max) {
	if ($null -eq $text) { return '' }
	$text = ($text -replace '\s+', ' ').Trim()
	if ($text.Length -gt $max) { return $text.Substring(0, $max - 1) + $ellipsis }
	return $text
}

function Get-Name($item) {
	$name = [string]$item.project
	if ([string]::IsNullOrWhiteSpace($name)) { $name = 'Claude' }
	$title = [string]$item.title
	if (-not [string]::IsNullOrWhiteSpace($title)) { $name = '{0} {1} {2}' -f $name, $dot, $title }
	return $name
}

function Get-Urgency($session) {
	switch ([string]$session.state) {
		'waiting' { return 0 }
		'retrying' { return 1 }
		'background' { return 3 }
		default { return 2 }
	}
}

function Set-Bar([System.Drawing.Color]$color, [double]$fraction) {
	# Clamped by hand: [Math]::Max(0, $double) resolves to the (int, int) overload and truncates.
	if ($fraction -lt 0) { $fraction = 0 }
	if ($fraction -gt 1) { $fraction = 1 }
	$fillPanel.BackColor = $color
	$fillPanel.Width = [int]($trackPanel.Width * $fraction)
	$stripePanel.BackColor = $color
}

function Update-Widget {
	$status = Read-StatusFile
	$sessions = @()
	$recent = @()
	$limitResetsAt = 0
	$source = 'transcripts'
	if ($null -ne $status) {
		$sessions = @($status.sessions | Where-Object { $_ })
		$recent = @($status.recent | Where-Object { $_ })
		if ($status.limitResetsAt) { $limitResetsAt = [double]$status.limitResetsAt }
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
		Show-Idle $recent $limitResetsAt
		return
	}

	# The most urgent first - Claude waiting on you beats everything - then the one waited on longest.
	$session = $sessions |
		Sort-Object -Property @{ Expression = { Get-Urgency $_ } }, @{ Expression = { [double]$_.elapsedMs }; Descending = $true } |
		Select-Object -First 1
	$extra = ''
	if ($sessions.Count -gt 1) { $extra = '  +{0} more' -f ($sessions.Count - 1) }
	$name = Get-Name $session
	$state = [string]$session.state
	if ([string]::IsNullOrWhiteSpace($state)) { $state = 'working' } # a status file from an older build
	$elapsed = Format-Clock $session.elapsedMs

	if ($state -eq 'waiting') {
		$titleLabel.Text = (Limit-Text ('Needs you ' + $dot + ' ' + $name) 34) + $extra
		$detail = [string]$session.waitDetail
		if ([string]::IsNullOrWhiteSpace($detail)) { $detail = 'Claude is waiting for your answer' }
		$metaLabel.Text = Limit-Text $detail 58
		if ($session.waitMs) {
			$stepLabel.Text = 'waiting {0}   {1}   the clock is paused' -f (Format-Clock ([double]$session.waitMs)), $dot
		} else {
			$stepLabel.Text = 'waiting for you   ' + $dot + '   ' + $elapsed + ' since the prompt'
		}
		Set-Bar $waitColor 1
		# A new question flashes the window once, so it is noticed even on a busy desktop.
		$key = $name + '|' + $detail
		if ($key -ne $script:lastWaitKey) {
			$script:lastWaitKey = $key
			$script:flashColor = $waitColor
			$script:flashTicks = 8
		}
		return
	}
	$script:lastWaitKey = ''
	$titleLabel.Text = (Limit-Text $name 34) + $extra

	if ($state -eq 'retrying') {
		$retry = [string]$session.retry
		$attempt = ($retry -split ' ', 2)[0]
		$message = ''
		if ($retry.Contains(' ')) { $message = ($retry -split ' ', 2)[1] }
		$metaLabel.Text = '{0}   retrying {1}' -f $elapsed, $attempt
		$stepLabel.Text = Limit-Text $message 60
		Set-Bar $waitColor ([double]$session.progress)
		return
	}

	if ($state -eq 'background') {
		$metaLabel.Text = '{0}   reply done {1} {2} agents working' -f $elapsed, $dot, $session.agents
		$stepLabel.Text = Limit-Text ([string]$session.prompt) 60
		Set-Bar $agentColor 1
		return
	}

	$tasks = ''
	if ($session.tasksTotal -gt 0) { $tasks = '   {0}/{1} tasks' -f $session.tasksDone, $session.tasksTotal }
	if ($session.etaMs -gt 0) {
		$suffix = ''
		if (-not $session.confident) { $suffix = '?' }
		$metaLabel.Text = '{0} / ~{1}{2}   {3} tools{4}' -f $elapsed, (Format-Clock $session.etaMs), $suffix, $session.tools, $tasks
		Set-Bar $accent ([double]$session.progress)
	} else {
		$note = ''
		if ($source -eq 'transcripts') { $note = '   (no estimate without VS Code)' }
		$metaLabel.Text = '{0}   {1} tools{2}{3}' -f $elapsed, $session.tools, $tasks, $note
		Set-Bar $accent 0
	}

	if (-not [string]::IsNullOrWhiteSpace([string]$session.task)) {
		$stepLabel.Text = Limit-Text ([string]$session.task) 60
		return
	}
	$step = [string]$session.lastStep
	if ([string]::IsNullOrWhiteSpace($step)) { $step = 'thinking' }
	if ($session.stepMs -gt 5000) { $step = '{0} {1}' -f $step, (Format-Clock ([double]$session.stepMs)) }
	$what = [string]$session.stepDetail
	if ([string]::IsNullOrWhiteSpace($what)) { $what = [string]$session.prompt }
	if ([string]::IsNullOrWhiteSpace($what)) {
		$stepLabel.Text = $step
	} else {
		$stepLabel.Text = Limit-Text ('{0} - {1}' -f $step, $what) 60
	}
}

# Nothing running: show the prompt that just finished for a few minutes, since a glance after walking
# back is exactly when the result matters; otherwise idle, with any usage limit still in force.
function Show-Idle($recent, [double]$limitResetsAt) {
	$script:lastWaitKey = ''
	$last = $recent | Sort-Object -Property endedAt -Descending | Select-Object -First 1
	if ($null -ne $last) {
		$word = 'Done'
		$color = $doneColor
		switch ([string]$last.status) {
			'error' { $word = 'Stopped'; $color = $failColor }
			'limited' { $word = 'Usage limit'; $color = $waitColor }
			'interrupted' { $word = 'Interrupted'; $color = $agentColor }
		}
		$titleLabel.Text = Limit-Text ('{0} {1} {2}' -f $word, $dot, (Get-Name $last)) 44
		$facts = @(Format-Duration ([double]$last.durationMs))
		if ($last.files -gt 0) { $facts += ('{0} files +{1} {2}{3}' -f $last.files, $last.added, $minus, $last.removed) }
		$facts += ('{0} tools' -f $last.tools)
		$metaLabel.Text = $facts -join ('   ' + $dot + '   ')
		$stepLabel.Text = Limit-Text ([string]$last.headline) 60
		Set-Bar $color 1
		return
	}
	$titleLabel.Text = 'Claude is idle'
	if ($limitResetsAt -gt 0) {
		$reset = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$limitResetsAt).LocalDateTime.ToString('t')
		$metaLabel.Text = 'Usage limit ' + $dot + ' resets at ' + $reset
	} else {
		$metaLabel.Text = 'Waiting for a prompt'
	}
	$stepLabel.Text = ''
	Set-Bar $track 0
}

# Asking for the widget again means "where is it?", so it always lands in the same known corner and
# flashes, rather than quietly coming to the front wherever it happened to be left.
function Show-Widget {
	$form.Location = Get-DefaultLocation
	$form.WindowState = 'Normal'
	$form.Show()
	$form.TopMost = $true
	$form.BringToFront()
	[void]$form.Activate()

	$script:flashColor = $accent
	$script:flashTicks = 6
}

# Pulses the border so the eye catches it even on a busy desktop.
function Update-Flash {
	if ($script:flashTicks -le 0) {
		if ($form.BackColor -ne $background) { $form.BackColor = $background }
		return
	}
	$script:flashTicks--
	if ($script:flashTicks % 2 -eq 0) {
		$form.BackColor = $script:flashColor
	} else {
		$form.BackColor = $background
	}
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
	try {
		if (Test-Path -LiteralPath $closeRequestPath) {
			Remove-Item -LiteralPath $closeRequestPath -Force -ErrorAction SilentlyContinue
			$form.Close()
			return
		}
		if (Test-Path -LiteralPath $showRequestPath) {
			Remove-Item -LiteralPath $showRequestPath -Force -ErrorAction SilentlyContinue
			Show-Widget
		}
		Update-Flash
		Update-Widget
	} catch { }
})

$form.Add_Shown({
	$timer.Start()
	$script:flashTicks = 6
	try { Update-Widget } catch { }
})

$form.Add_FormClosing({
	$timer.Stop()
	try {
		if (Test-Path -LiteralPath $pidPath) {
			$recorded = (Get-Content -LiteralPath $pidPath -Raw).Trim([char]0xFEFF, ' ', "`r", "`n")
			if ($recorded -eq $PID.ToString()) { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue }
		}
	} catch { }
	try {
		if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
		[System.IO.File]::WriteAllText($positionPath, ('{0},{1}' -f $form.Location.X, $form.Location.Y))
	} catch { }
})

[void][System.Windows.Forms.Application]::Run($form)
