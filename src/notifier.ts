import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { formatDuration, truncate } from './format';
import { Session, Turn } from './types';

interface ProgressHandle {
	finish: () => void;
	report: (percent: number, message: string) => void;
}

/** Completion notifications, plus the optional live progress notification. */
export class Notifier implements vscode.Disposable {
	private readonly progress = new Map<string, ProgressHandle>();

	constructor(private readonly estimator: Estimator, private readonly extensionPath: string) {}

	private get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('claudePromptMonitor');
	}

	turnStarted(session: Session, turn: Turn): void {
		if (!this.config.get<boolean>('showProgressNotification')) {
			return;
		}
		const key = progressKey(session, turn);
		let reported = 0;
		void vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Claude · ${truncate(turn.prompt, 48)}`,
				cancellable: false
			},
			(progress) =>
				new Promise<void>((resolve) => {
					this.progress.set(key, {
						finish: () => {
							this.progress.delete(key);
							resolve();
						},
						report: (percent, message) => {
							const increment = Math.max(0, percent - reported);
							reported = percent;
							progress.report({ increment, message });
						}
					});
				})
		);
	}

	turnUpdated(session: Session, turn: Turn): void {
		const handle = this.progress.get(progressKey(session, turn));
		if (!handle) {
			return;
		}
		const estimate = this.estimator.current(turn, Date.now());
		const last = turn.steps.length ? turn.steps[turn.steps.length - 1].label : 'thinking';
		handle.report(
			Math.round(estimate.progress * 100),
			`${last} · about ${formatDuration(estimate.remainingMs)} left`
		);
	}

	async turnEnded(session: Session, turn: Turn): Promise<void> {
		this.progress.get(progressKey(session, turn))?.finish();

		if (!this.config.get<boolean>('notifyOnComplete') || turn.status === 'abandoned') {
			return;
		}
		const duration = (turn.endedAt ?? Date.now()) - turn.startedAt;
		const minimum = (this.config.get<number>('notifyMinDurationSeconds') ?? 15) * 1000;
		if (duration < minimum) {
			return;
		}
		if (this.config.get<boolean>('notifyOnlyWhenUnfocused') && vscode.window.state.focused) {
			return;
		}

		const project = session.cwd ? path.basename(session.cwd) : 'Claude';
		const detail = `${formatDuration(duration)} · ${turn.toolCount} tool ${
			turn.toolCount === 1 ? 'call' : 'calls'
		} · ${formatTokens(turn.outputTokens)} out`;
		const message =
			turn.status === 'error'
				? `Claude stopped with an error in ${project} — ${detail}`
				: `Claude finished in ${project} — ${detail}`;

		this.playSound();

		const target = this.config.get<string>('notificationTarget') ?? 'editor';
		if (target === 'native' || target === 'both') {
			// A desktop notification survives VS Code being minimised, which is the whole point of
			// walking away from a long prompt.
			this.showNativeNotification(
				turn.status === 'error' ? `Claude stopped — ${project}` : `Claude finished — ${project}`,
				`${detail}\n${truncate(turn.prompt, 120)}`
			);
		}
		if (target === 'native') {
			return;
		}

		const show = turn.status === 'error' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
		const choice = await show(message, { detail: truncate(turn.prompt, 200) } as vscode.MessageOptions, 'Show Session');
		if (choice === 'Show Session') {
			await vscode.commands.executeCommand('claudePromptMonitor.showPanel');
		}
	}

	/**
	 * Hands the text to the OS notification centre. Both strings travel through the environment or as
	 * argv entries, never through a shell string, so prompt text cannot be interpreted as a command.
	 */
	private showNativeNotification(title: string, body: string): void {
		try {
			if (process.platform === 'win32') {
				const script = path.join(this.extensionPath, 'media', 'toast.ps1');
				spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true,
					env: { ...process.env, CPM_TOAST_TITLE: title, CPM_TOAST_BODY: body }
				}).unref();
			} else if (process.platform === 'darwin') {
				// Separate -e lines keep the script out of a single quoted string.
				const applescript = ['on run {t, b}', 'display notification b with title t', 'end run'];
				spawn('osascript', [...applescript.flatMap((line) => ['-e', line]), title, body], {
					detached: true,
					stdio: 'ignore'
				}).unref();
			} else {
				spawn('notify-send', ['--app-name=Claude Code', title, body], {
					detached: true,
					stdio: 'ignore'
				}).unref();
			}
		} catch {
			/* no notification daemon available; the editor notification still covers it */
		}
	}

	private playSound(): void {
		if (!this.config.get<boolean>('playSound')) {
			return;
		}
		try {
			if (process.platform === 'win32') {
				spawn('powershell', ['-NoProfile', '-Command', '[console]::beep(880,180)'], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true
				}).unref();
			} else if (process.platform === 'darwin') {
				spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { detached: true, stdio: 'ignore' }).unref();
			} else {
				spawn('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga'], {
					detached: true,
					stdio: 'ignore'
				}).unref();
			}
		} catch {
			/* a missing sound player is not worth surfacing */
		}
	}

	dispose(): void {
		for (const handle of this.progress.values()) {
			handle.finish();
		}
		this.progress.clear();
	}
}

function progressKey(session: Session, turn: Turn): string {
	return `${session.sessionId}:${turn.startedAt}`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;
}
