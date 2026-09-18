import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { formatClock, truncate } from './format';
import { TurnTracker } from './turnTracker';

/** Live elapsed time and ETA for whatever Claude is currently working on. */
export class StatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private timer?: NodeJS.Timeout;

	constructor(private readonly tracker: TurnTracker, private readonly estimator: Estimator) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.command = 'claudePromptMonitor.showPanel';
		this.timer = setInterval(() => this.render(), 1000);
	}

	render(): void {
		if (!vscode.workspace.getConfiguration('claudePromptMonitor').get<boolean>('statusBar')) {
			this.item.hide();
			return;
		}
		const active = this.tracker.getActiveTurns().filter(({ session }) => this.tracker.isInScope(session));
		if (!active.length) {
			this.item.hide();
			return;
		}

		const now = Date.now();
		// Oldest running turn first: that is the one the user is waiting on.
		active.sort((a, b) => a.turn.startedAt - b.turn.startedAt);
		const { session, turn } = active[0];
		const estimate = this.estimator.current(turn, now);
		const elapsed = now - turn.startedAt;
		const count = active.length > 1 ? ` ×${active.length}` : '';
		const eta = estimate.confident ? `~${formatClock(estimate.totalMs)}` : `~${formatClock(estimate.totalMs)}?`;

		this.item.text = `$(sync~spin) Claude${count} ${formatClock(elapsed)} / ${eta}`;
		this.item.tooltip = this.tooltip(now);
		this.item.show();
	}

	private tooltip(now: number): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = true;
		for (const { session, turn } of this.tracker.getActiveTurns()) {
			if (!this.tracker.isInScope(session)) {
				continue;
			}
			const estimate = this.estimator.current(turn, now);
			const project = session.cwd ? path.basename(session.cwd) : 'unknown';
			const last = turn.steps.length ? turn.steps[turn.steps.length - 1].label : 'starting';
			md.appendMarkdown(`**${project}** — ${truncate(turn.prompt, 60)}\n\n`);
			md.appendMarkdown(
				`- elapsed ${formatClock(now - turn.startedAt)}, about ${formatClock(estimate.remainingMs)} left` +
					`${estimate.confident ? '' : ' (low confidence)'}\n`
			);
			md.appendMarkdown(`- ${turn.toolCount} tool calls, now: ${last}\n\n`);
		}
		return md;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
		this.item.dispose();
	}
}
