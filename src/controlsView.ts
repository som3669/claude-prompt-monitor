import * as vscode from 'vscode';

/**
 * A small panel of real buttons above the Sessions list.
 *
 * A tree row cannot render a button, and welcome-view buttons only appear while the view is empty —
 * which is exactly when you do not need them. A webview gives a button that is always there, styled
 * from the theme so it matches the editor's own primary buttons.
 */
export class ControlsView implements vscode.WebviewViewProvider {
	static readonly viewType = 'claudePromptMonitor.controls';

	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html(view.webview);

		view.webview.onDidReceiveMessage((message: { command?: string }) => {
			if (typeof message?.command === 'string') {
				void vscode.commands.executeCommand(message.command);
			}
		});
	}

	private html(webview: vscode.Webview): string {
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	body {
		margin: 0;
		padding: 10px;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: transparent;
	}
	button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 100%;
		padding: 6px 12px;
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 2px;
		font-family: inherit;
		font-size: inherit;
		line-height: 18px;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 2px;
	}
	.primary {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}
	.primary:hover {
		background: var(--vscode-button-hoverBackground);
	}
	.secondary {
		margin-top: 6px;
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
	}
	.secondary:hover {
		background: var(--vscode-button-secondaryHoverBackground);
	}
	p {
		margin: 8px 2px 0;
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
		line-height: 1.4;
	}
</style>
</head>
<body>
	<button class="primary" id="open">Open Desktop Widget</button>
	<button class="secondary" id="stats">Timing Stats</button>
	<p>The widget floats above other windows and keeps showing progress while VS Code is minimised.</p>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('open').addEventListener('click', () => {
			vscode.postMessage({ command: 'claudePromptMonitor.openOverlay' });
		});
		document.getElementById('stats').addEventListener('click', () => {
			vscode.postMessage({ command: 'claudePromptMonitor.showStats' });
		});
	</script>
</body>
</html>`;
	}
}
