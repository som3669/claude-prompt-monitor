import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { formatClock, formatDuration, truncate } from './format';
import { TurnTracker } from './turnTracker';
import { Session, Step, Turn } from './types';

type Node = SessionNode | StepNode;

class SessionNode {
	readonly kind = 'session';
	constructor(readonly session: Session) {}
}

class StepNode {
	readonly kind = 'step';
	constructor(readonly session: Session, readonly step: Step, readonly index: number) {}
}

/** The Sessions tree: one row per Claude session, expanded into the steps of its current turn. */
export class SessionsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private timer?: NodeJS.Timeout;

	constructor(private readonly tracker: TurnTracker, private readonly estimator: Estimator) {
		this.timer = setInterval(() => {
			if (this.tracker.getActiveTurns().length) {
				this.refresh();
			}
		}, 1000);
	}

	refresh(): void {
		this.changed.fire(undefined);
	}

	getChildren(element?: Node): Node[] {
		if (!element) {
			return this.tracker
				.getSessions()
				.filter((session) => this.tracker.isInScope(session))
				.map((session) => new SessionNode(session));
		}
		if (element.kind !== 'session') {
			return [];
		}
		const turn = element.session.turn ?? element.session.lastTurn;
		if (!turn) {
			return [];
		}
		// Newest step first so the current activity is always the top row.
		return turn.steps
			.map((step, index) => new StepNode(element.session, step, index))
			.reverse()
			.slice(0, 60);
	}

	getTreeItem(node: Node): vscode.TreeItem {
		return node.kind === 'session' ? this.sessionItem(node) : this.stepItem(node);
	}

	private sessionItem(node: SessionNode): vscode.TreeItem {
		const { session } = node;
		const turn = session.turn ?? session.lastTurn;
		const label = session.cwd ? path.basename(session.cwd) : session.sessionId.slice(0, 8);
		const item = new vscode.TreeItem(
			label,
			turn?.steps.length
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None
		);
		item.id = session.sessionId;
		item.contextValue = 'session';
		item.description = this.sessionDescription(session, turn);
		item.iconPath = new vscode.ThemeIcon(this.sessionIcon(turn));
		item.tooltip = this.sessionTooltip(session, turn);
		item.command = {
			command: 'claudePromptMonitor.openTranscript',
			title: 'Open Transcript',
			arguments: [node]
		};
		return item;
	}

	private sessionDescription(session: Session, turn: Turn | undefined): string {
		if (!turn) {
			return 'no prompts yet';
		}
		if (turn.status === 'running') {
			const now = Date.now();
			const estimate = this.estimator.current(turn, now);
			const eta = `${formatClock(estimate.totalMs)}${estimate.confident ? '' : '?'}`;
			return `${formatClock(now - turn.startedAt)} / ~${eta} · ${turn.toolCount} tools`;
		}
		const duration = (turn.endedAt ?? turn.startedAt) - turn.startedAt;
		const status = turn.status === 'done' ? 'done' : turn.status;
		return `${status} in ${formatDuration(duration)} · ${turn.toolCount} tools`;
	}

	private sessionIcon(turn: Turn | undefined): string {
		if (!turn) {
			return 'circle-outline';
		}
		switch (turn.status) {
			case 'running':
				return 'sync~spin';
			case 'done':
				return 'check';
			case 'error':
				return 'error';
			default:
				return 'circle-slash';
		}
	}

	private sessionTooltip(session: Session, turn: Turn | undefined): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**Session** \`${session.sessionId}\`\n\n`);
		if (session.cwd) {
			md.appendMarkdown(`- cwd: \`${session.cwd}\`\n`);
		}
		if (session.gitBranch) {
			md.appendMarkdown(`- branch: \`${session.gitBranch}\`\n`);
		}
		if (session.entrypoint) {
			md.appendMarkdown(`- via: ${session.entrypoint}\n`);
		}
		if (turn) {
			md.appendMarkdown(`\n**Prompt**\n\n${truncate(turn.prompt, 400)}\n`);
			if (turn.model) {
				md.appendMarkdown(`\n- model: ${turn.model}`);
			}
			md.appendMarkdown(`\n- output: ${turn.outputTokens} tokens`);
		}
		return md;
	}

	private stepItem(node: StepNode): vscode.TreeItem {
		const { step, session } = node;
		const turn = session.turn ?? session.lastTurn;
		const item = new vscode.TreeItem(step.label, vscode.TreeItemCollapsibleState.None);
		item.id = `${session.sessionId}:${turn?.startedAt ?? 0}:${node.index}`;
		item.contextValue = 'step';
		item.description = turn ? `+${formatClock(step.at - turn.startedAt)}` : undefined;
		item.iconPath = new vscode.ThemeIcon(stepIcon(step.label));
		item.tooltip = step.detail ? `${step.label}\n${step.detail}` : step.label;
		return item;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
		this.changed.dispose();
	}
}

export function sessionOf(node: unknown): Session | undefined {
	return node && typeof node === 'object' && 'session' in node ? (node as SessionNode).session : undefined;
}

function stepIcon(label: string): string {
	const name = label.replace('subagent: ', '');
	switch (name) {
		case 'thinking':
			return 'lightbulb';
		case 'message':
			return 'comment';
		case 'Read':
		case 'NotebookRead':
			return 'file';
		case 'Edit':
		case 'Write':
		case 'NotebookEdit':
			return 'edit';
		case 'Bash':
		case 'PowerShell':
			return 'terminal';
		case 'Grep':
		case 'Glob':
			return 'search';
		case 'Agent':
			return 'organization';
		case 'WebFetch':
		case 'WebSearch':
			return 'globe';
		default:
			return 'tools';
	}
}
