import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { formatDuration, formatTokens, truncate } from './format';
import {
	changedFiles,
	describeFiles,
	errorAdvice,
	fileTotals,
	headline,
	liveState,
	projectName,
	sessionTitle,
	turnKey,
	waitVerb
} from './present';
import { powershellPath } from './platform';
import { Session, Turn, Wait } from './types';

interface ProgressHandle {
	finish: () => void;
	report: (percent: number, message: string) => void;
}

/** A wait this short is usually answered before a notification could help. */
const WAIT_DEBOUNCE_MS = 2500;

/** Completion, needs-you and limit notifications, plus the optional live progress notification. */
export class Notifier implements vscode.Disposable {
	private readonly progress = new Map<string, ProgressHandle>();
	private readonly waitTimers = new Map<string, NodeJS.Timeout>();
	private readonly resetTimers = new Map<number, NodeJS.Timeout>();

	constructor(private readonly estimator: Estimator, private readonly extensionPath: string) {}

	private get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('claudePromptMonitor');
	}

	turnStarted(session: Session, turn: Turn): void {
		if (!this.config.get<boolean>('showProgressNotification')) {
			return;
		}
		const key = turnKey(turn);
		let reported = 0;
		void vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Claude · ${truncate(sessionTitle(session) ?? turn.prompt, 48)}`,
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
							reported = Math.max(reported, percent);
							progress.report({ increment, message });
						}
					});
				})
		);
	}

	turnUpdated(session: Session, turn: Turn): void {
		const handle = this.progress.get(turnKey(turn));
		if (!handle) {
			return;
		}
		const state = liveState(turn);
		if (state === 'waiting') {
			handle.report(0, `waiting for you — ${truncate(turn.wait?.detail ?? 'input needed', 60)}`);
			return;
		}
		if (state === 'background') {
			handle.report(0, 'reply done — waiting on background agents');
			return;
		}
		const estimate = this.estimator.current(turn, Date.now());
		const last = turn.steps.length ? turn.steps[turn.steps.length - 1].label : 'thinking';
		handle.report(Math.round(estimate.progress * 100), `${last} · about ${formatDuration(estimate.remainingMs)} left`);
	}

	/** Claude is blocked on the user. Notify once the wait has lasted long enough to be real. */
	waitStarted(session: Session, turn: Turn, wait: Wait): void {
		if (!this.config.get<boolean>('notifyOnWaiting', true)) {
			return;
		}
		const key = turnKey(turn);
		clearTimeout(this.waitTimers.get(key));
		this.waitTimers.set(
			key,
			setTimeout(() => {
				this.waitTimers.delete(key);
				if (turn.wait !== wait || turn.status !== 'running') {
					return; // already answered
				}
				if (this.config.get<boolean>('notifyOnlyWhenUnfocused') && vscode.window.state.focused) {
					return;
				}
				void this.announceWait(session, turn, wait);
			}, WAIT_DEBOUNCE_MS)
		);
	}

	private async announceWait(session: Session, turn: Turn, wait: Wait): Promise<void> {
		const where = placeName(session);
		const what =
			wait.kind === 'question' && wait.detail
				? `“${truncate(wait.detail, 140)}”`
				: wait.kind === 'plan'
					? 'A plan is ready for your approval.'
					: wait.kind === 'permission'
						? truncate(wait.detail || 'Claude needs permission to continue.', 140)
						: truncate(wait.detail || 'Claude is waiting for your input.', 140);

		this.playSound();
		const target = this.config.get<string>('notificationTarget') ?? 'editor';
		if (target === 'native' || target === 'both') {
			this.showNativeNotification(`Claude ${waitVerb(turn)} — ${where}`, what);
		}
		if (target === 'native') {
			return;
		}
		const actions = session.entrypoint === 'claude-vscode' ? ['Open Claude', 'Show'] : ['Show'];
		const choice = await vscode.window.showWarningMessage(`Claude ${waitVerb(turn)} in ${where}: ${what}`, ...actions);
		if (choice === 'Open Claude') {
			await vscode.commands.executeCommand('claudePromptMonitor.focusClaude', session.sessionId);
		} else if (choice === 'Show') {
			await vscode.commands.executeCommand('claudePromptMonitor.showDashboard');
		}
	}

	async turnEnded(session: Session, turn: Turn): Promise<void> {
		this.progress.get(turnKey(turn))?.finish();
		const key = turnKey(turn);
		clearTimeout(this.waitTimers.get(key));
		this.waitTimers.delete(key);

		if (turn.status === 'limited' && turn.limitResetsAt) {
			this.scheduleLimitReset(session, turn.limitResetsAt);
		}
		if (!this.config.get<boolean>('notifyOnComplete')) {
			return;
		}
		// Stopped by the user, or the user already typed the next prompt: they are right there.
		if (turn.status === 'abandoned' || turn.status === 'interrupted' || turn.endedBy === 'next-prompt') {
			return;
		}
		const duration = (turn.endedAt ?? Date.now()) - turn.startedAt;
		const minimum = (this.config.get<number>('notifyMinDurationSeconds') ?? 15) * 1000;
		// A failure needs acting on however quickly it came; a quick success does not need announcing.
		if (turn.status === 'done' && duration < minimum) {
			return;
		}
		if (this.config.get<boolean>('notifyOnlyWhenUnfocused') && vscode.window.state.focused) {
			return;
		}

		const where = placeName(session);
		const files = changedFiles(turn);
		const facts = [
			formatDuration(duration),
			describeFiles(fileTotals(files)),
			`${turn.toolCount} ${turn.toolCount === 1 ? 'tool call' : 'tool calls'}`,
			turn.agentIds.length ? `${turn.agentIds.length} ${turn.agentIds.length === 1 ? 'agent' : 'agents'}` : '',
			turn.waitedMs >= 5000 ? `waited ${formatDuration(turn.waitedMs)} for you` : '',
			turn.outputTokens ? `${formatTokens(turn.outputTokens)} tokens out` : ''
		]
			.filter(Boolean)
			.join(' · ');
		const advice = turn.status === 'done' ? headline(turn.finalText) : errorAdvice(turn);
		const title =
			turn.status === 'done'
				? `Claude finished — ${where}`
				: turn.status === 'limited'
					? `Claude hit a usage limit — ${where}`
					: `Claude stopped — ${where}`;

		this.playSound();
		const target = this.config.get<string>('notificationTarget') ?? 'editor';
		if (target === 'native' || target === 'both') {
			// A desktop notification survives VS Code being minimised, which is the whole point of
			// walking away from a long prompt.
			this.showNativeNotification(title, [facts, advice ?? truncate(turn.prompt, 120)].join('\n'));
		}
		if (target === 'native') {
			return;
		}

		const message = `${title} · ${facts}${advice ? ` — ${advice}` : ''}`;
		const actions: string[] = [];
		if (files.length && turn.status === 'done') {
			actions.push('Review Changes');
		}
		if (session.entrypoint === 'claude-vscode') {
			actions.push('Open Claude');
		}
		actions.push('Show');
		const show = turn.status === 'done' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
		const choice = await show(message, ...actions);
		if (choice === 'Review Changes') {
			await vscode.commands.executeCommand('claudePromptMonitor.reviewChanges', key);
		} else if (choice === 'Open Claude') {
			await vscode.commands.executeCommand('claudePromptMonitor.focusClaude', session.sessionId);
		} else if (choice === 'Show') {
			await vscode.commands.executeCommand('claudePromptMonitor.showDashboard');
		}
	}

	/** One reminder per reset time, however many sessions hit the same limit. */
	scheduleLimitReset(session: Session, resetsAt: number): void {
		if (!this.config.get<boolean>('notifyOnLimitReset', true) || this.resetTimers.has(resetsAt)) {
			return;
		}
		const delay = resetsAt - Date.now();
		if (delay <= 0 || delay > 24 * 3600_000) {
			return;
		}
		const where = placeName(session);
		this.resetTimers.set(
			resetsAt,
			setTimeout(() => {
				this.resetTimers.delete(resetsAt);
				const text = `Claude's usage limit has reset — you can pick up where you left off in ${where}.`;
				this.playSound();
				const target = this.config.get<string>('notificationTarget') ?? 'editor';
				if (target === 'native' || target === 'both') {
					this.showNativeNotification('Claude is available again', text);
				}
				if (target !== 'native') {
					void vscode.window.showInformationMessage(text);
				}
			}, delay)
		);
	}

	/**
	 * Hands the text to the OS notification centre. Both strings travel through the environment or as
	 * argv entries, never through a shell string, so prompt text cannot be interpreted as a command.
	 */
	private showNativeNotification(title: string, body: string): void {
		try {
			if (process.platform === 'win32') {
				// No `detached`: on Windows that is DETACHED_PROCESS, and powershell.exe then exits in
				// ~80ms without running the script. That is why native toasts never appeared before 0.1.4.
				const script = path.join(this.extensionPath, 'media', 'toast.ps1');
				spawn(powershellPath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
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
				const command =
					"$p = Join-Path $env:SystemRoot 'Media\\Windows Notify System Generic.wav'; " +
					'if (Test-Path -LiteralPath $p) { (New-Object Media.SoundPlayer $p).PlaySync() } else { [console]::beep(880,180) }';
				spawn(powershellPath(), ['-NoProfile', '-Command', command], { stdio: 'ignore', windowsHide: true }).unref();
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
		for (const timer of [...this.waitTimers.values(), ...this.resetTimers.values()]) {
			clearTimeout(timer);
		}
		this.waitTimers.clear();
		this.resetTimers.clear();
	}
}

function placeName(session: Session): string {
	const title = sessionTitle(session);
	const project = projectName(session);
	return title ? `${project} (${truncate(title, 48)})` : project;
}
