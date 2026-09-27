import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BeforeContentProvider, openOne, reviewChanges } from './changes';
import { DashboardView } from './dashboardView';
import { Estimator, toRecord } from './estimator';
import { formatDuration } from './format';
import { HookBridge } from './hookBridge';
import { Notifier } from './notifier';
import { changedFiles, projectName, sessionTitle, summarize, turnKey } from './present';
import { RecentStore } from './recentStore';
import { SessionsView, sessionOf } from './sessionsView';
import { StatusBar } from './statusBar';
import { StatusFile } from './statusFile';
import { claudeHome, TranscriptWatcher } from './transcriptWatcher';
import { projectKey, TurnTracker } from './turnTracker';
import { FileChange, Session, Turn } from './types';

const BACKFILL_FILES = 12;
const BACKFILL_BYTES = 3 * 1024 * 1024;

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('claudePromptMonitor');
}

function staleMinutes(): number {
	return config().get<number>('staleTurnMinutes') ?? 30;
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Claude Prompt Monitor');
	context.subscriptions.push(output);

	const estimator = new Estimator(context.globalState, () => config().get<number>('historySize') ?? 200);
	const recent = new RecentStore(context.globalState);
	const tracker = new TurnTracker({ inScope, claudeHome, staleMinutes });
	const view = new SessionsView(tracker, estimator);
	const statusBar = new StatusBar(tracker, estimator);
	const notifier = new Notifier(estimator, context.extensionPath);
	const statusFile = new StatusFile(tracker, estimator, context.extensionPath, () => recent.all());
	const hooks = new HookBridge(tracker, context.extensionPath, path.join(statusFile.directory, 'events.jsonl'), output);
	const dashboard = new DashboardView({
		tracker,
		estimator,
		recent,
		hooks,
		extensionUri: context.extensionUri,
		isOverlayRunning: () => statusFile.isOverlayRunning()
	});
	context.subscriptions.push(tracker, recent, view, statusBar, notifier, statusFile, hooks, dashboard);

	context.subscriptions.push(
		vscode.window.createTreeView('claudePromptMonitor.sessions', { treeDataProvider: view }),
		vscode.window.registerWebviewViewProvider(DashboardView.viewType, dashboard),
		vscode.workspace.registerTextDocumentContentProvider(BeforeContentProvider.scheme, new BeforeContentProvider())
	);

	const refreshAll = () => {
		statusBar.render();
		statusFile.write();
		view.refresh();
		dashboard.refresh();
	};

	let watcher: TranscriptWatcher | undefined;

	const start = () => {
		watcher?.dispose();
		watcher = undefined;
		if (!config().get<boolean>('enabled')) {
			output.appendLine('Disabled by setting; not watching transcripts.');
			return;
		}
		const next = new TranscriptWatcher({
			// Agents write their own transcripts; only busy sessions' ones are worth listing every poll.
			extraDirs: () =>
				tracker.hotSessions().map((session) => path.join(path.dirname(session.file), session.sessionId, 'subagents')),
			replayWindowMs: staleMinutes() * 60_000
		});
		learnFromPastTurns(next, estimator, recent, output);
		next.onEntry((event) => tracker.handle(event));
		next.start();
		recent.flush(); // turns replayed from the last few minutes
		statusFile.writeHistory(estimator.export());
		watcher = next;
		refreshAll();
		output.appendLine('Watching Claude Code transcripts.');
	};

	tracker.onTurnStarted(({ session, turn, replay }) => {
		turn.initialEstimateMs = estimator.initial(turn);
		if (!tracker.isInScope(session)) {
			return;
		}
		refreshAll();
		if (replay) {
			return; // already running before this window loaded; nothing new to announce
		}
		notifier.turnStarted(session, turn);
		if (config().get<boolean>('overlayAutoStart')) {
			statusFile.openOverlay();
		}
		output.appendLine(
			`[start] ${label(session)} — ${turn.prompt.slice(0, 80)}` +
				(turn.initialEstimateMs ? ` (estimate ${formatDuration(turn.initialEstimateMs)})` : '')
		);
	});

	tracker.onTurnUpdated(({ session, turn, replay }) => {
		if (!replay && tracker.isInScope(session)) {
			notifier.turnUpdated(session, turn);
		}
	});

	tracker.onWaitStarted(({ session, turn, wait, replay }) => {
		refreshAll();
		if (replay || !tracker.isInScope(session)) {
			return;
		}
		output.appendLine(`[waiting] ${label(session)} — ${wait.kind}${wait.detail ? `: ${wait.detail.slice(0, 80)}` : ''}`);
		notifier.waitStarted(session, turn, wait);
		if (config().get<boolean>('overlayAutoStart')) {
			statusFile.openOverlay();
		}
	});

	tracker.onTurnEnded(({ session, turn, replay }) => {
		if (worthRemembering(turn)) {
			recent.add(summarize(session, turn), replay);
		}
		if (!replay) {
			estimator.record(turn);
			statusFile.writeHistory(estimator.export());
			const duration = (turn.endedAt ?? Date.now()) - turn.startedAt;
			output.appendLine(
				`[${turn.status}] ${label(session)} — ${formatDuration(duration)}, ${turn.toolCount} tools` +
					(turn.errorMessage ? ` (${turn.errorMessage.slice(0, 80)})` : '')
			);
			if (tracker.isInScope(session)) {
				void notifier.turnEnded(session, turn);
			}
		}
		refreshAll();
	});

	// Frequent enough that a turn waiting on background agents closes promptly once they report back.
	const sweep = setInterval(() => {
		tracker.sweep();
		view.refresh();
	}, 10_000);
	context.subscriptions.push({ dispose: () => clearInterval(sweep) });

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration('claudePromptMonitor.enabled') ||
				event.affectsConfiguration('claudePromptMonitor.claudeHome') ||
				event.affectsConfiguration('claudePromptMonitor.pollIntervalMs')
			) {
				start();
			}
			refreshAll();
		})
	);

	/** A turn by its key: running now, the last one of a session, or remembered in Recent. */
	const findTurn = (key: string): { files: FileChange[]; title: string; prompt: string; file?: string } | undefined => {
		for (const session of tracker.getSessions()) {
			for (const turn of [session.turn, session.lastTurn]) {
				if (turn && turnKey(turn) === key) {
					return {
						files: changedFiles(turn),
						title: sessionTitle(session) ?? projectName(session),
						prompt: turn.prompt,
						file: session.file
					};
				}
			}
		}
		const summary = recent.get(key);
		return summary
			? { files: summary.files, title: summary.title ?? summary.project, prompt: summary.prompt, file: summary.transcript }
			: undefined;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('claudePromptMonitor.showPanel', () =>
			vscode.commands.executeCommand('claudePromptMonitor.sessions.focus')
		),
		vscode.commands.registerCommand('claudePromptMonitor.showDashboard', () =>
			vscode.commands.executeCommand(`${DashboardView.viewType}.focus`)
		),
		vscode.commands.registerCommand('claudePromptMonitor.openOverlay', () => statusFile.openOverlay()),
		vscode.commands.registerCommand('claudePromptMonitor.toggleOverlay', () => statusFile.toggleOverlay()),
		vscode.commands.registerCommand('claudePromptMonitor.refresh', () => {
			watcher?.poll();
			tracker.sweep();
			refreshAll();
		}),
		vscode.commands.registerCommand('claudePromptMonitor.toggleNotifications', async () => {
			const next = !config().get<boolean>('notifyOnComplete');
			await config().update('notifyOnComplete', next, vscode.ConfigurationTarget.Global);
			void vscode.window.setStatusBarMessage(`$(bell) Claude notifications ${next ? 'on' : 'off'}`, 3000);
			dashboard.refresh(true);
		}),
		vscode.commands.registerCommand('claudePromptMonitor.clearHistory', async () => {
			const confirm = await vscode.window.showWarningMessage(
				'Clear all recorded prompt timings? Estimates will be rough until new history builds up.',
				{ modal: true },
				'Clear'
			);
			if (confirm === 'Clear') {
				estimator.clear();
				void vscode.window.showInformationMessage('Claude timing history cleared.');
			}
		}),
		vscode.commands.registerCommand('claudePromptMonitor.clearRecent', async () => {
			const confirm = await vscode.window.showWarningMessage(
				'Clear the Recent list and today’s numbers? Timing history for estimates is kept.',
				{ modal: true },
				'Clear'
			);
			if (confirm === 'Clear') {
				recent.clear();
			}
		}),
		vscode.commands.registerCommand('claudePromptMonitor.showStats', () => {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const stats = estimator.stats(folder ? projectKey(folder) : undefined);
			if (!stats) {
				void vscode.window.showInformationMessage('No prompt timings recorded yet.');
				return;
			}
			void vscode.window.showInformationMessage(
				`${stats.count} prompts recorded · median ${formatDuration(stats.p50)} · 90th percentile ${formatDuration(
					stats.p90
				)} (time Claude worked, not counting waits for you)`
			);
		}),
		vscode.commands.registerCommand('claudePromptMonitor.openTranscript', async (target?: unknown) => {
			const file =
				sessionOf(target)?.file ??
				(typeof target === 'string' ? tracker.getSession(target)?.file ?? recentTranscript(recent, target) : undefined) ??
				(await pickSession(tracker))?.file;
			if (!file) {
				return;
			}
			if (!fs.existsSync(file)) {
				void vscode.window.showWarningMessage(`The transcript is no longer at ${file}.`);
				return;
			}
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			await vscode.window.showTextDocument(document, { preview: true });
		}),
		vscode.commands.registerCommand('claudePromptMonitor.reviewChanges', async (target?: unknown) => {
			const session = sessionOf(target);
			const turn = session ? session.turn ?? session.lastTurn : undefined;
			const key = typeof target === 'string' ? target : turn ? turnKey(turn) : recent.all()[0]?.key;
			const found = key ? findTurn(key) : undefined;
			if (!found) {
				void vscode.window.showInformationMessage('No finished prompt to review yet.');
				return;
			}
			await reviewChanges(found.files, `Claude: ${found.title}`);
		}),
		vscode.commands.registerCommand('claudePromptMonitor.openFileChange', async (target: unknown, filePath?: string) => {
			if (target && typeof target === 'object' && 'path' in target) {
				await openOne(target as FileChange);
				return;
			}
			const found = typeof target === 'string' ? findTurn(target) : undefined;
			const file = found?.files.find((candidate) => candidate.path === filePath);
			if (file) {
				await openOne(file);
			}
		}),
		vscode.commands.registerCommand('claudePromptMonitor.copyPrompt', async (key?: string) => {
			const found = key ? findTurn(key) : undefined;
			if (!found) {
				return;
			}
			await vscode.env.clipboard.writeText(found.prompt);
			void vscode.window.setStatusBarMessage('$(copy) Prompt copied', 2500);
		}),
		vscode.commands.registerCommand('claudePromptMonitor.focusClaude', async (sessionId?: string) => {
			const session = sessionId ? tracker.getSession(sessionId) : undefined;
			if (session && session.entrypoint && session.entrypoint !== 'claude-vscode') {
				// A terminal session: the terminal is the closest thing to "go to Claude".
				await vscode.commands.executeCommand('workbench.action.terminal.focus');
				return;
			}
			for (const command of ['claude-vscode.focus', 'claude-vscode.editor.openLast', 'claude-vscode.sidebar.open']) {
				try {
					await vscode.commands.executeCommand(command);
					return;
				} catch {
					/* this build of the Claude Code extension does not have it; try the next */
				}
			}
			void vscode.window.showInformationMessage('Could not find the Claude Code extension to switch to.');
		}),
		vscode.commands.registerCommand('claudePromptMonitor.installHooks', () => hooks.install()),
		vscode.commands.registerCommand('claudePromptMonitor.uninstallHooks', () => hooks.uninstall())
	);

	context.subscriptions.push({ dispose: () => watcher?.dispose() });
	watchForNewerBuild(context, output);
	hooks.start();
	start();
}

/**
 * A VS Code window keeps running the build it started with, so installing a new version changes the
 * files on disk while the window carries on with the old code - silently, which is very confusing when
 * a fix does not appear to take. This notices and offers the reload.
 */
function watchForNewerBuild(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
	const manifest = path.join(context.extensionPath, 'package.json');
	const versionOnDisk = (): string | undefined => {
		try {
			return JSON.parse(fs.readFileSync(manifest, 'utf8')).version as string;
		} catch {
			return undefined;
		}
	};

	const running = versionOnDisk();
	if (!running) {
		return;
	}
	let prompted = false;
	const timer = setInterval(() => {
		const current = versionOnDisk();
		if (prompted || !current || current === running) {
			return;
		}
		prompted = true;
		output.appendLine(`Installed build is now ${current}; this window is running ${running}.`);
		void vscode.window
			.showInformationMessage(
				`Claude Prompt Monitor ${current} is installed, but this window is still running ${running}.`,
				'Reload Window'
			)
			.then((choice) => {
				if (choice === 'Reload Window') {
					void vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			});
	}, 30_000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
	/* disposables handle teardown */
}

/**
 * Replays the tail of recent transcripts so estimates are useful from the first prompt, and so the
 * Recent list has something in it on a fresh install.
 */
function learnFromPastTurns(
	watcher: TranscriptWatcher,
	estimator: Estimator,
	recent: RecentStore,
	output: vscode.OutputChannel
): void {
	const silent = new TurnTracker({ claudeHome, staleMinutes });
	let learned = 0;
	const subscription = silent.onTurnEnded(({ session, turn }) => {
		if (worthRemembering(turn) && !recent.has(turnKey(turn))) {
			recent.add(summarize(session, turn), true);
		}
		if (turn.status !== 'done' || turn.trigger !== 'human' || !turn.endedAt) {
			return;
		}
		estimator.seed(toRecord(turn));
		learned += 1;
	});
	try {
		watcher.backfill(BACKFILL_FILES, BACKFILL_BYTES, (event) => silent.handle(event));
		estimator.flushSeed();
		recent.flush();
		output.appendLine(`Learned timings from ${learned} past prompts (${estimator.size} records total).`);
	} catch (error) {
		output.appendLine(`Could not read past transcripts: ${String(error)}`);
	} finally {
		subscription.dispose();
		silent.dispose();
	}
}

/** Interrupted-at-once and never-answered turns are noise in the Recent list. */
function worthRemembering(turn: Turn): boolean {
	if (turn.status === 'abandoned') {
		return turn.toolCount > 0;
	}
	if (turn.status === 'interrupted') {
		return turn.toolCount > 0 || (turn.endedAt ?? 0) - turn.startedAt > 5000;
	}
	return true;
}

function recentTranscript(recent: RecentStore, sessionId: string): string | undefined {
	return recent.all().find((item) => item.sessionId === sessionId)?.transcript;
}

function inScope(cwd: string | undefined): boolean {
	if (config().get<string>('scope') === 'all') {
		return true;
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return true; // nothing to scope to, so show everything rather than nothing
	}
	if (!cwd) {
		return false;
	}
	const target = normalize(cwd);
	return folders.some((folder) => {
		const root = normalize(folder.uri.fsPath);
		return target === root || target.startsWith(`${root}${path.sep}`);
	});
}

function normalize(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function label(session: Session): string {
	return session.cwd ? path.basename(session.cwd) : session.sessionId.slice(0, 8);
}

async function pickSession(tracker: TurnTracker): Promise<Session | undefined> {
	const sessions = tracker.getSessions();
	if (!sessions.length) {
		void vscode.window.showInformationMessage('No Claude sessions seen yet.');
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		sessions.map((session) => ({
			label: sessionTitle(session) ?? projectName(session),
			description: `${projectName(session)} · ${session.turn ? 'running' : 'idle'}`,
			detail: session.file,
			session
		})),
		{ placeHolder: 'Select a Claude session transcript', matchOnDescription: true }
	);
	return picked?.session;
}
