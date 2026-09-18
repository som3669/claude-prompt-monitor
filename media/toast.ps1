# Shows a Windows toast notification. Title and body arrive through the environment
# (CPM_TOAST_TITLE / CPM_TOAST_BODY) so arbitrary prompt text can never be parsed as script.
$ErrorActionPreference = 'Stop'

$title = $env:CPM_TOAST_TITLE
$body = $env:CPM_TOAST_BODY
if ([string]::IsNullOrWhiteSpace($title)) { $title = 'Claude Code' }
if ($null -eq $body) { $body = '' }

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
	# Toasts need a registered AppUserModelID; PowerShell's own is always present.
	$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
	[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
	# WinRT is unavailable (Server Core, PowerShell 7 without the compat layer, locked-down policy).
	# Fall back to a balloon tip so something still reaches the desktop.
	try {
		Add-Type -AssemblyName System.Windows.Forms
		$icon = New-Object System.Windows.Forms.NotifyIcon
		$icon.Icon = [System.Drawing.SystemIcons]::Information
		$icon.Visible = $true
		$icon.ShowBalloonTip(6000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)
		Start-Sleep -Seconds 6
		$icon.Dispose()
	} catch {
		exit 1
	}
}
