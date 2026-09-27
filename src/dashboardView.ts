import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { HookBridge } from './hookBridge';
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
	taskProgress,
	turnAgents,
	turnKey
} from './present';
import { RecentStore } from './recentStore';
import { TurnTracker } from './turnTracker';

export interface DashboardDeps {
	tracker: TurnTracker;
	estimator: Estimator;
	recent: RecentStore;
	hooks: HookBridge;
	extensionUri: vscode.Uri;
	isOverlayRunning: () => boolean;
}

/**
 * The Monitor panel: what every session is doing now (most urgent first), today's numbers, and the
 * recent prompts with their outcome and changes. Everything the page shows comes from transcripts,
 * so it is rendered as text, never as HTML.
 */
export class DashboardView implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'claudePromptMonitor.dashboard';

	private view?: vscode.WebviewView;
	private timer?: NodeJS.Timeout;
	private lastRecentVersion = -1;
	private recentVersion = 0;
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(private readonly deps: DashboardDeps) {
		this.subscriptions.push(
			deps.recent.onDidChange(() => {
				this.recentVersion += 1;
				this.refresh();
			}),
			deps.hooks.onDidChange(() => this.refresh(true))
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.deps.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);

		view.webview.onDidReceiveMessage(async (message: { command?: unknown; args?: unknown }) => {
			if (message?.command === 'ready') {
				this.refresh(true);
				return;
			}
			// Only this extension's own commands, whatever the page asks for.
			if (typeof message?.command !== 'string' || !message.command.startsWith('claudePromptMonitor.')) {
				return;
			}
			const args = Array.isArray(message.args) ? message.args : [];
			await vscode.commands.executeCommand(message.command, ...args);
			setTimeout(() => this.refresh(true), 1200); // the widget takes a moment to open or close
		});
		view.onDidChangeVisibility(() => this.schedule());
		view.onDidDispose(() => {
			this.view = undefined;
			this.schedule();
		});
		this.schedule();
	}

	/** Ticks once a second while the panel is visible; nothing runs while it is hidden. */
	private schedule(): void {
		const visible = !!this.view?.visible;
		if (visible && !this.timer) {
			this.timer = setInterval(() => this.refresh(), 1000);
			this.refresh(true);
		} else if (!visible && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	refresh(force = false): void {
		if (!this.view?.visible) {
			return;
		}
		const includeRecent = force || this.recentVersion !== this.lastRecentVersion;
		this.lastRecentVersion = this.recentVersion;
		void this.view.webview.postMessage({ type: 'state', state: this.state(includeRecent) });
	}

	private state(includeRecent: boolean): unknown {
		const { tracker, estimator, recent, hooks } = this.deps;
		const now = Date.now();
		const config = vscode.workspace.getConfiguration('claudePromptMonitor');
		const active = byUrgency(tracker.getActiveTurns(), now).map(({ session, turn }) => {
			const state = liveState(turn, now);
			const estimate = estimator.current(turn, now);
			const step = currentStep(turn, now);
			const totals = fileTotals(changedFiles(turn));
			const agents = state === 'background' ? backgroundAgents(session, turn, now) : turnAgents(session, turn);
			return {
				key: turnKey(turn),
				sessionId: session.sessionId,
				canFocus: session.entrypoint === 'claude-vscode',
				project: projectName(session),
				title: sessionTitle(session) ?? '',
				prompt: turn.prompt.slice(0, 240),
				state,
				trigger: turn.trigger,
				elapsedMs: now - turn.startedAt,
				etaMs: estimate.wallTotalMs,
				remainingMs: estimate.remainingMs,
				confident: estimate.confident,
				progress: estimate.progress,
				step: step.label,
				stepDetail: step.detail ?? '',
				stepMs: step.runningMs ?? 0,
				tools: turn.toolCount,
				errors: turn.errorCount,
				tasks: taskProgress(session, turn) ?? null,
				agents: agents.map((agent) => ({
					description: agent.description,
					type: agent.type ?? '',
					status: agent.status,
					tools: agent.tools,
					lastStep: agent.lastStep ?? ''
				})),
				files: totals,
				wait: turn.wait ? { kind: turn.wait.kind, detail: turn.wait.detail ?? '', ms: now - turn.wait.since } : null,
				retry: turn.retry ? { attempt: turn.retry.attempt, max: turn.retry.max, message: turn.retry.message } : null,
				queued: session.queued
			};
		});

		const limitResetsAt =
			tracker
				.getSessions()
				.map((session) => session.limitResetsAt ?? 0)
				.filter((resetsAt) => resetsAt > now)
				.sort((a, b) => a - b)[0] ?? null;

		const payload: Record<string, unknown> = {
			now,
			widgetRunning: this.deps.isOverlayRunning(),
			notificationsOn: config.get<boolean>('notifyOnComplete') !== false,
			hooksInstalled: hooks.isInstalled(),
			windows: process.platform === 'win32',
			active,
			limitResetsAt
		};

		if (includeRecent) {
			const today = recent.today(now).filter((item) => item.status !== 'abandoned');
			const files = new Set<string>();
			let added = 0;
			let removed = 0;
			for (const item of today) {
				for (const file of item.files) {
					files.add(file.path.toLowerCase());
					added += file.added;
					removed += file.removed;
				}
			}
			const durations = today.map((item) => item.activeMs).sort((a, b) => a - b);
			payload.today = {
				prompts: today.filter((item) => item.trigger === 'human').length,
				activeMs: today.reduce((sum, item) => sum + item.activeMs, 0),
				waits: today.filter((item) => item.waitedMs > 0).length,
				waitedMs: today.reduce((sum, item) => sum + item.waitedMs, 0),
				files: files.size,
				added,
				removed,
				failed: today.filter((item) => item.status === 'error' || item.status === 'limited').length,
				medianMs: durations.length ? durations[Math.floor((durations.length - 1) / 2)] : 0
			};
			payload.recent = recent
				.all()
				.filter((item) => item.status !== 'abandoned' || item.tools > 0)
				.slice(0, 40)
				.map((item) => ({
					key: item.key,
					sessionId: item.sessionId,
					project: item.project,
					title: item.title ?? '',
					prompt: item.prompt.slice(0, 300),
					status: item.status,
					trigger: item.trigger,
					endedAt: item.endedAt,
					durationMs: item.endedAt - item.startedAt,
					waitedMs: item.waitedMs,
					tools: item.tools,
					errors: item.errors,
					agents: item.agents,
					tasks: item.tasksTotal ? `${item.tasksDone ?? 0}/${item.tasksTotal}` : '',
					files: item.files.map((file) => ({
						path: file.path,
						name: path.basename(file.path),
						added: file.added,
						removed: file.removed,
						created: !!file.before?.created
					})),
					totals: fileTotals(item.files),
					headline: item.status === 'done' ? headline(item.finalText, 220) ?? '' : errorAdvice(item),
					canFocus: tracker.getSession(item.sessionId)?.entrypoint === 'claude-vscode'
				}));
		}
		return payload;
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Claude Monitor</title>
</head>
<body>
	<header class="toolbar" role="toolbar" aria-label="Monitor controls">
		<button id="widget" class="btn primary" type="button">Open desktop widget</button>
		<button id="bell" class="icon-btn" type="button" aria-pressed="true" title="Completion notifications"></button>
	</header>
	<div id="live" class="sr-only" aria-live="polite"></div>
	<section aria-labelledby="now-h">
		<h2 id="now-h" class="section">Now</h2>
		<div id="limit" class="limit" hidden></div>
		<div id="now" class="cards"></div>
		<p id="idle" class="empty" hidden>Nothing running. Send Claude a prompt and it shows up here.</p>
	</section>
	<section aria-labelledby="today-h">
		<h2 id="today-h" class="section">Today</h2>
		<div id="today" class="tiles"></div>
	</section>
	<section aria-labelledby="recent-h">
		<div class="section-row">
			<h2 id="recent-h" class="section">Recent</h2>
			<button id="clear" class="link" type="button">Clear</button>
		</div>
		<ul id="recent" class="recent"></ul>
		<p id="recent-empty" class="empty" hidden>Finished prompts appear here, with what they changed.</p>
	</section>
	<footer id="hooks" class="hooks"></footer>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
