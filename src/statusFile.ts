import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import {
	backgroundAgents,
	byUrgency,
	changedFiles,
	currentStep,
	errorAdvice,
	fileTotals,
	headline,
	liveState,
	projectName,
	sessionTitle,
	taskProgress
} from './present';
import { powershellPath } from './platform';
import { claudeHome } from './transcriptWatcher';
import { TurnTracker } from './turnTracker';
import { TurnSummary } from './types';

/** Finished turns stay on the widget this long, so a glance after walking back still shows the result. */
const RECENT_WINDOW_MS = 3 * 60_000;

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
		private readonly extensionPath: string,
		private readonly recent: () => TurnSummary[] = () => []
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
		// exactly the one you are most likely to have walked away from. Most urgent first.
		const sessions = byUrgency(this.tracker.getActiveTurns(), now).map(({ session, turn }) => {
			const estimate = this.estimator.current(turn, now);
			const step = currentStep(turn, now);
			const tasks = taskProgress(session, turn);
			const totals = fileTotals(changedFiles(turn));
			return {
				project: projectName(session),
				title: sessionTitle(session) ?? '',
				prompt: turn.prompt.slice(0, 160),
				state: liveState(turn, now),
				elapsedMs: now - turn.startedAt,
				etaMs: estimate.wallTotalMs,
				progress: estimate.progress,
				confident: estimate.confident,
				lastStep: step.label,
				stepDetail: step.detail ?? '',
				stepMs: step.runningMs ?? 0,
				tools: turn.toolCount,
				errors: turn.errorCount,
				tasksDone: tasks?.done ?? 0,
				tasksTotal: tasks?.total ?? 0,
				task: tasks?.current ?? '',
				agents: backgroundAgents(session, turn, now).length,
				waitKind: turn.wait?.kind ?? '',
				waitDetail: turn.wait?.detail ?? '',
				waitMs: turn.wait ? now - turn.wait.since : 0,
				retry: turn.retry ? `${turn.retry.attempt}/${turn.retry.max} ${turn.retry.message}` : '',
				files: totals.count,
				added: totals.added,
				removed: totals.removed
			};
		});
		const recent = this.recent()
			.filter((item) => now - item.endedAt < RECENT_WINDOW_MS && item.status !== 'abandoned')
			.slice(0, 3)
			.map((item) => {
				const totals = fileTotals(item.files);
				return {
					project: item.project,
					title: item.title ?? '',
					status: item.status,
					endedAt: item.endedAt,
					durationMs: item.endedAt - item.startedAt,
					tools: item.tools,
					files: totals.count,
					added: totals.added,
					removed: totals.removed,
					headline:
						item.status === 'done'
							? headline(item.finalText, 90) ?? ''
							: errorAdvice(item)
				};
			});
		const limitResetsAt =
			this.tracker
				.getSessions()
				.map((session) => session.limitResetsAt ?? 0)
				.filter((resetsAt) => resetsAt > now)
				.sort((a, b) => a - b)[0] ?? null;

		// Once nothing is running or recent, write the empty state a single time and then stop rewriting,
		// so the widget's staleness check can tell "nothing running" from "VS Code went away".
		const empty = !sessions.length && !recent.length && !limitResetsAt;
		if (empty && this.lastWriteWasEmpty) {
			return;
		}
		this.lastWriteWasEmpty = empty;

		try {
			fs.mkdirSync(this.directory, { recursive: true });
			const payload = JSON.stringify({ v: 2, writtenAt: now, sessions, recent, limitResetsAt });
			const temporary = `${this.file}.${process.pid}.tmp`;
			// Write-then-rename, so the widget never reads a half-written file.
			fs.writeFileSync(temporary, payload, 'utf8');
			fs.renameSync(temporary, this.file);
		} catch {
			/* a temp directory we cannot write to is not worth interrupting the user over */
		}
	}

	get pidFile(): string {
		return path.join(this.directory, 'overlay.pid');
	}

	/** True when a widget process recorded in the pid file is still alive. */
	isOverlayRunning(): boolean {
		try {
			const recorded = Number(fs.readFileSync(this.pidFile, 'utf8').trim());
			if (!Number.isInteger(recorded) || recorded <= 0) {
				return false;
			}
			// Signal 0 tests for existence without touching the process.
			process.kill(recorded, 0);
			return true;
		} catch {
			return false;
		}
	}

	/** Opens the widget, or closes it if it is already up. */
	toggleOverlay(): void {
		if (!this.isOverlayRunning()) {
			this.openOverlay();
			return;
		}
		try {
			fs.writeFileSync(path.join(this.directory, 'overlay-close.request'), new Date().toISOString(), 'utf8');
			this.log('close requested');
			void vscode.window.setStatusBarMessage('$(window) Claude desktop widget closed', 3000);
		} catch (error) {
			this.log(`close request failed: ${String(error)}`);
			void vscode.window.showErrorMessage(`Could not close the desktop widget: ${String(error)}`);
		}
	}

	get diagnosticsFile(): string {
		return path.join(this.directory, 'open-overlay.log');
	}

	/** Appends one line of evidence per attempt, so a failed launch can be diagnosed after the fact. */
	private log(message: string): void {
		try {
			fs.mkdirSync(this.directory, { recursive: true });
			fs.appendFileSync(this.diagnosticsFile, `${new Date().toISOString()}  ${message}\n`, 'utf8');
		} catch {
			/* diagnostics are best-effort */
		}
	}

	/** Starts the widget, or asks an already-running one to come to the front. */
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
		if (!fs.existsSync(script)) {
			// Happens when the window is still running a build that was replaced underneath it.
			this.log(`script missing: ${script}`);
			void vscode.window
				.showErrorMessage(
					'The desktop widget script is missing from the installed extension. Reloading the window usually fixes this.',
					'Reload Window'
				)
				.then((choice) => {
					if (choice === 'Reload Window') {
						void vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			return;
		}

		try {
			// stderr is kept rather than discarded: a PowerShell that refuses to start used to fail in
			// complete silence, which is indistinguishable from a dead button.
			// No `detached`: on Windows that means DETACHED_PROCESS, so the child gets no console at all
			// and powershell.exe exits immediately with code 0 - the widget appeared to never start.
			// Without it the process still outlives this one, which is what the widget needs.
			const child = spawn(powershellPath(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
			this.log(`spawned pid=${child.pid ?? 'none'} script=${script}`);

			let stderr = '';
			child.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on('error', (error) => {
				this.log(`spawn error: ${error.message}`);
				void vscode.window.showErrorMessage(`Could not start the desktop widget: ${error.message}`);
			});
			child.on('exit', (code) => {
				// Exit 0 is the normal hand-over to an already-running widget.
				const firstLine = stderr.trim().split('\n')[0] ?? '';
				this.log(`exit code=${code} stderr=${firstLine}`);
				if (code !== 0 && code !== null) {
					void vscode.window.showErrorMessage(
						`The desktop widget could not start (PowerShell exit ${code}). ${firstLine}`
					);
				}
			});
			child.unref();

			// Without this an already-open widget makes the button look dead: the second process hands
			// over and exits, and the widget just moves, which is easy to miss on a busy desktop.
			void vscode.window.setStatusBarMessage(
				'$(window) Claude desktop widget opened - top right of the primary screen',
				4000
			);
		} catch (error) {
			this.log(`throw: ${String(error)}`);
			void vscode.window.showErrorMessage(`Could not start the desktop widget: ${String(error)}`);
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
	}
}
