import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { claudeHome } from './transcriptWatcher';
import { TurnTracker } from './turnTracker';

/**
 * Publishes the current state to a small JSON file and launches the desktop widget that reads it.
 *
 * The widget is a separate process on purpose: it has to keep showing progress when VS Code is
 * minimised, and to survive VS Code being closed. It falls back to reading transcripts itself when
 * this file goes stale, so it is never left showing a frozen reading.
 */
export class StatusFile implements vscode.Disposable {
	private timer?: NodeJS.Timeout;
	private lastWriteWasEmpty = false;

	constructor(
		private readonly tracker: TurnTracker,
		private readonly estimator: Estimator,
		private readonly extensionPath: string
	) {
		this.timer = setInterval(() => this.write(), 1000);
	}

	get directory(): string {
		return path.join(os.tmpdir(), 'claude-prompt-monitor');
	}

	get file(): string {
		return path.join(this.directory, 'status.json');
	}

	get historyFile(): string {
		return path.join(this.directory, 'history.json');
	}

	/**
	 * Publishes the timing history so the widget can estimate on its own. Unlike the status file this
	 * one is never treated as stale: old timings are exactly as useful when VS Code is closed.
	 */
	writeHistory(records: unknown[]): void {
		try {
			fs.mkdirSync(this.directory, { recursive: true });
			const payload = JSON.stringify(records.slice(-500));
			const temporary = `${this.historyFile}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, payload, 'utf8');
			fs.renameSync(temporary, this.historyFile);
		} catch {
			/* the widget falls back to deriving its own samples from transcripts */
		}
	}

	write(): void {
		const now = Date.now();
		// Not filtered by scope: the widget is a desktop-wide view, and a session in another project is
		// exactly the one you are most likely to have walked away from.
		const sessions = this.tracker
			.getActiveTurns()
			.map(({ session, turn }) => {
				const estimate = this.estimator.current(turn, now);
				const lastStep = turn.steps.length ? turn.steps[turn.steps.length - 1].label : 'thinking';
				return {
					project: session.cwd ? path.basename(session.cwd) : session.sessionId.slice(0, 8),
					prompt: turn.prompt.slice(0, 160),
					elapsedMs: now - turn.startedAt,
					etaMs: estimate.totalMs,
					progress: estimate.progress,
					confident: estimate.confident,
					lastStep,
					tools: turn.toolCount
				};
			});

		// Once the last prompt ends, write the empty state a single time and then stop rewriting, so the
		// widget's staleness check can tell "nothing running" from "VS Code went away".
		if (!sessions.length && this.lastWriteWasEmpty) {
			return;
		}
		this.lastWriteWasEmpty = sessions.length === 0;

		try {
			fs.mkdirSync(this.directory, { recursive: true });
			const payload = JSON.stringify({ writtenAt: now, sessions });
			const temporary = `${this.file}.${process.pid}.tmp`;
			// Write-then-rename, so the widget never reads a half-written file.
			fs.writeFileSync(temporary, payload, 'utf8');
			fs.renameSync(temporary, this.file);
		} catch {
			/* a temp directory we cannot write to is not worth interrupting the user over */
		}
	}

	/** Starts the widget. A second launch is a no-op: the script holds a single-instance mutex. */
	openOverlay(): void {
		if (process.platform !== 'win32') {
			void vscode.window.showWarningMessage(
				'The desktop widget is Windows-only for now. On other platforms use the status bar, or set claudePromptMonitor.notificationTarget to "native".'
			);
			return;
		}
		this.write();
		const script = path.join(this.extensionPath, 'media', 'overlay.ps1');
		const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-StatusPath', this.file];
		// The widget reads transcripts itself when this file goes stale, so it needs the same home.
		const home = claudeHome();
		if (home) {
			args.push('-ClaudeHome', home);
		}
		try {
			spawn('powershell', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not start the desktop widget: ${String(error)}`);
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
	}
}
