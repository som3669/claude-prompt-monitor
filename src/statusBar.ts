import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { formatClock, formatTimeOfDay, truncate } from './format';
import {
	backgroundAgents,
	byUrgency,
	changedFiles,
	currentStep,
	describeFiles,
	fileTotals,
	liveState,
	projectName,
	sessionTitle,
	taskProgress
} from './present';
import { TurnTracker } from './turnTracker';
import { Session, Turn } from './types';

/**
 * One item that always shows the most urgent thing: Claude needs you, a retry, the running prompt with
 * its clock and ETA, or background agents. When nothing runs it shows an active usage limit, if any.
 */
export class StatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private timer?: NodeJS.Timeout;

	constructor(private readonly tracker: TurnTracker, private readonly estimator: Estimator) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.item.name = 'Claude Prompt Monitor';
		this.item.command = 'claudePromptMonitor.showDashboard';
		this.timer = setInterval(() => this.render(), 1000);
	}

	render(): void {
		if (!vscode.workspace.getConfiguration('claudePromptMonitor').get<boolean>('statusBar')) {
			this.item.hide();
			return;
		}
		const now = Date.now();
		const active = byUrgency(
			this.tracker.getActiveTurns().filter(({ session }) => this.tracker.isInScope(session)),
			now
		);
		if (!active.length) {
			this.renderIdle(now);
			return;
		}

		const { session, turn } = active[0];
		const count = active.length > 1 ? ` ×${active.length}` : '';
		const state = liveState(turn, now);
		this.item.backgroundColor = undefined;
		this.item.color = undefined;

		if (state === 'waiting') {
			this.item.text = `$(bell-dot) Claude needs you${count} · ${projectName(session)}`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
		} else if (state === 'retrying' && turn.retry) {
			this.item.text = `$(sync~spin) Claude retrying ${turn.retry.attempt}/${turn.retry.max}${count}`;
		} else if (state === 'background') {
			const agents = backgroundAgents(session, turn, now).length;
			this.item.text = `$(organization) Claude${count} · ${agents} ${agents === 1 ? 'agent' : 'agents'} running`;
		} else {
			const estimate = this.estimator.current(turn, now);
			const eta = `~${formatClock(estimate.wallTotalMs)}${estimate.confident ? '' : '?'}`;
			const tasks = taskProgress(session, turn);
			const taskText = tasks ? ` · ${tasks.done}/${tasks.total}` : '';
			this.item.text = `$(sync~spin) Claude${count} ${formatClock(now - turn.startedAt)} / ${eta}${taskText}`;
		}
		this.item.tooltip = this.tooltip(active, now);
		this.item.show();
	}

	private renderIdle(now: number): void {
		const limited = this.tracker
			.getSessions()
			.map((session) => session.limitResetsAt ?? 0)
			.filter((resetsAt) => resetsAt > now)
			.sort((a, b) => a - b)[0];
		if (!limited) {
			this.item.hide();
			return;
		}
		this.item.text = `$(watch) Claude limit · resets ${formatTimeOfDay(limited)}`;
		this.item.backgroundColor = undefined;
		this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
		this.item.tooltip = `Claude hit its usage limit. It resets at ${formatTimeOfDay(limited)}.`;
		this.item.show();
	}

	private tooltip(active: { session: Session; turn: Turn }[], now: number): vscode.MarkdownString {
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = { enabledCommands: ['claudePromptMonitor.showDashboard', 'claudePromptMonitor.focusClaude'] };
		for (const { session, turn } of active) {
			const state = liveState(turn, now);
			const title = sessionTitle(session);
			md.appendMarkdown(`**${escape(projectName(session))}**${title ? ` — ${escape(truncate(title, 60))}` : ''}\n\n`);
			md.appendMarkdown(`${escape(truncate(turn.prompt, 90))}\n\n`);
			if (state === 'waiting' && turn.wait) {
				md.appendMarkdown(`$(bell-dot) **Waiting for you** · ${formatClock(now - turn.wait.since)}`);
				if (turn.wait.detail) {
					md.appendMarkdown(` — ${escape(truncate(turn.wait.detail, 120))}`);
				}
				md.appendMarkdown('\n\n');
			} else if (state === 'retrying' && turn.retry) {
				md.appendMarkdown(
					`$(sync) Retrying ${turn.retry.attempt}/${turn.retry.max} — ${escape(truncate(turn.retry.message, 90))}\n\n`
				);
			} else if (state === 'background') {
				const agents = backgroundAgents(session, turn, now);
				md.appendMarkdown(`$(organization) Reply done; waiting on ${agents.length} background agent(s)\n\n`);
				for (const agent of agents) {
					md.appendMarkdown(`- ${escape(agent.description)}${agent.lastStep ? ` — ${escape(truncate(agent.lastStep, 60))}` : ''}\n`);
				}
				md.appendMarkdown('\n');
			} else {
				const estimate = this.estimator.current(turn, now);
				md.appendMarkdown(
					`elapsed ${formatClock(now - turn.startedAt)} · about ${formatClock(estimate.remainingMs)} left` +
						`${estimate.confident ? '' : ' (low confidence)'}\n\n`
				);
				const step = currentStep(turn, now);
				const running = step.runningMs !== undefined && step.runningMs > 5000 ? ` · ${formatClock(step.runningMs)}` : '';
				md.appendMarkdown(
					`now: **${escape(step.label)}**${running}${step.detail ? ` — ${escape(truncate(step.detail, 70))}` : ''}\n\n`
				);
			}
			const tasks = taskProgress(session, turn);
			const files = describeFiles(fileTotals(changedFiles(turn)));
			const facts = [
				`${turn.toolCount} tools`,
				tasks ? `tasks ${tasks.done}/${tasks.total}` : '',
				files,
				turn.errorCount ? `${turn.errorCount} failed` : ''
			].filter(Boolean);
			md.appendMarkdown(`${facts.join(' · ')}\n\n---\n\n`);
		}
		md.appendMarkdown('[$(dashboard) Dashboard](command:claudePromptMonitor.showDashboard)');
		const first = active[0]?.session;
		if (first?.entrypoint === 'claude-vscode') {
			md.appendMarkdown(
				` · [$(comment-discussion) Open Claude](command:claudePromptMonitor.focusClaude?${encodeURIComponent(
					JSON.stringify([first.sessionId])
				)})`
			);
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

function escape(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
