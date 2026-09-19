import * as path from 'path';
import * as vscode from 'vscode';
import { ControlsView } from './controlsView';
import { Estimator } from './estimator';
import { formatDuration } from './format';
import { Notifier } from './notifier';
import { SessionsView, sessionOf } from './sessionsView';
import { StatusBar } from './statusBar';
import { StatusFile } from './statusFile';
import { TranscriptWatcher } from './transcriptWatcher';
import { TurnTracker, projectKey } from './turnTracker';
import { Session } from './types';

const BACKFILL_FILES = 12;
const BACKFILL_BYTES = 3 * 1024 * 1024;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Claude Prompt Monitor');
	context.subscriptions.push(output);

	const estimator = new Estimator(
		context.globalState,
		() => vscode.workspace.getConfiguration('claudePromptMonitor').get<number>('historySize') ?? 200
	);
	const tracker = new TurnTracker(inScope);
	const view = new SessionsView(tracker, estimator);
	const statusBar = new StatusBar(tracker, estimator);
	const notifier = new Notifier(estimator, context.extensionPath);
	const statusFile = new StatusFile(tracker, estimator, context.extensionPath);
	context.subscriptions.push(tracker, view, statusBar, notifier, statusFile);

	context.subscriptions.push(
		vscode.window.createTreeView('claudePromptMonitor.sessions', { treeDataProvider: view }),
		vscode.window.registerWebviewViewProvider(ControlsView.viewType, new ControlsView())
	);

	let watcher: TranscriptWatcher | undefined;

	const start = () => {
		watcher?.dispose();
		watcher = undefined;
		if (!vscode.workspace.getConfiguration('claudePromptMonitor').get<boolean>('enabled')) {
			output.appendLine('Disabled by setting; not watching transcripts.');
			return;
		}
		const next = new TranscriptWatcher();
		learnFromPastTurns(next, estimator, output);
		next.onEntry((event) => tracker.handle(event));
		next.start();
		statusFile.writeHistory(estimator.export());
		watcher = next;
		output.appendLine('Watching Claude Code transcripts.');
	};

	tracker.onTurnStarted(({ session, turn }) => {
		if (!tracker.isInScope(session)) {
			return;
		}
		turn.initialEstimateMs = estimator.initial(turn);
		notifier.turnStarted(session, turn);
		statusBar.render();
		statusFile.write();
		view.refresh();
		if (vscode.workspace.getConfiguration('claudePromptMonitor').get<boolean>('overlayAutoStart')) {
			statusFile.openOverlay();
		}
		output.appendLine(
			`[start] ${label(session)} — ${turn.prompt.slice(0, 80)}` +
				(turn.initialEstimateMs ? ` (estimate ${formatDuration(turn.initialEstimateMs)})` : '')
		);
	});

	tracker.onTurnUpdated(({ session, turn }) => {
		if (!tracker.isInScope(session)) {
			return;
		}
		notifier.turnUpdated(session, turn);
	});

	tracker.onTurnEnded(({ session, turn }) => {
		estimator.record(turn);
		statusBar.render();
		statusFile.write();
		statusFile.writeHistory(estimator.export());
		view.refresh();
		const duration = (turn.endedAt ?? Date.now()) - turn.startedAt;
		output.appendLine(`[${turn.status}] ${label(session)} — ${formatDuration(duration)}, ${turn.toolCount} tools`);
		if (tracker.isInScope(session)) {
			void notifier.turnEnded(session, turn);
		}
	});

	const sweep = setInterval(() => {
		tracker.sweep();
		view.refresh();
	}, 30_000);
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
			statusBar.render();
			view.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudePromptMonitor.showPanel', () =>
			vscode.commands.executeCommand('claudePromptMonitor.sessions.focus')
		),
		vscode.commands.registerCommand('claudePromptMonitor.openOverlay', () => statusFile.openOverlay()),
		vscode.commands.registerCommand('claudePromptMonitor.refresh', () => {
			watcher?.poll();
			tracker.sweep();
			view.refresh();
			statusBar.render();
		}),
		vscode.commands.registerCommand('claudePromptMonitor.toggleNotifications', async () => {
			const config = vscode.workspace.getConfiguration('claudePromptMonitor');
			const next = !config.get<boolean>('notifyOnComplete');
			await config.update('notifyOnComplete', next, vscode.ConfigurationTarget.Global);
			void vscode.window.showInformationMessage(
				`Claude completion notifications ${next ? 'enabled' : 'disabled'}.`
			);
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
				)}`
			);
		}),
		vscode.commands.registerCommand('claudePromptMonitor.openTranscript', async (node?: unknown) => {
			const session = sessionOf(node) ?? (await pickSession(tracker));
			if (!session) {
				return;
			}
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(session.file));
			await vscode.window.showTextDocument(document, { preview: true });
		})
	);

	context.subscriptions.push({ dispose: () => watcher?.dispose() });
	start();
}

export function deactivate(): void {
	/* disposables handle teardown */
}

/** Replays the tail of recent transcripts so estimates are useful from the first prompt. */
function learnFromPastTurns(watcher: TranscriptWatcher, estimator: Estimator, output: vscode.OutputChannel): void {
	const silent = new TurnTracker();
	let learned = 0;
	const subscription = silent.onTurnEnded(({ turn }) => {
		if (turn.status !== 'done' || !turn.endedAt) {
			return;
		}
		estimator.seed({
			project: turn.project,
			durationMs: turn.endedAt - turn.startedAt,
			toolCount: turn.toolCount,
			promptChars: turn.prompt.length,
			finishedAt: turn.endedAt
		});
		learned += 1;
	});
	try {
		watcher.backfill(BACKFILL_FILES, BACKFILL_BYTES, (event) => silent.handle(event));
		estimator.flushSeed();
		output.appendLine(`Learned timings from ${learned} past prompts (${estimator.size} records total).`);
	} catch (error) {
		output.appendLine(`Could not read past transcripts: ${String(error)}`);
	} finally {
		subscription.dispose();
		silent.dispose();
	}
}

function inScope(cwd: string | undefined): boolean {
	if (vscode.workspace.getConfiguration('claudePromptMonitor').get<string>('scope') === 'all') {
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
			label: session.cwd ? path.basename(session.cwd) : session.sessionId.slice(0, 8),
			description: session.turn ? 'running' : 'idle',
			detail: session.file,
			session
		})),
		{ placeHolder: 'Select a Claude session transcript' }
	);
	return picked?.session;
}
