import * as path from 'path';
import * as vscode from 'vscode';
import { Estimator } from './estimator';
import { formatClock, formatDuration, formatTokens, truncate } from './format';
import {
	changedFiles,
	describeFiles,
	fileTotals,
	liveState,
	projectName,
	sessionTitle,
	taskProgress,
	turnAgents,
	turnKey
} from './present';
import { TurnTracker } from './turnTracker';
import { AgentInfo, FileChange, Session, Step, TodoItem, Turn } from './types';

type Node = SessionNode | InfoNode | GroupNode | TodoNode | AgentNode | FileNode | StepNode;

class SessionNode {
	readonly kind = 'session';
	constructor(readonly session: Session) {}
}

/** A one-line fact under a session: what Claude is waiting for, or why it is retrying. */
class InfoNode {
	readonly kind = 'info';
	constructor(
		readonly session: Session,
		readonly id: string,
		readonly label: string,
		readonly icon: vscode.ThemeIcon,
		readonly tooltip: string,
		readonly command?: vscode.Command
	) {}
}

class GroupNode {
	readonly kind = 'group';
	constructor(readonly session: Session, readonly turn: Turn, readonly group: 'tasks' | 'agents' | 'files') {}
}

class TodoNode {
	readonly kind = 'todo';
	constructor(readonly session: Session, readonly todo: TodoItem, readonly index: number) {}
}

class AgentNode {
	readonly kind = 'agent';
	constructor(readonly session: Session, readonly agent: AgentInfo) {}
}

class FileNode {
	readonly kind = 'file';
	constructor(readonly session: Session, readonly turn: Turn, readonly file: FileChange) {}
}

class StepNode {
	readonly kind = 'step';
	constructor(readonly session: Session, readonly step: Step, readonly index: number) {}
}

/**
 * The Sessions tree: one row per Claude session. Under it, the turn's open wait or retry, its task
 * list, agents and changed files, then every step, newest first.
 */
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
				.filter((session) => this.tracker.isInScope(session) && (session.turn || session.lastTurn))
				.map((session) => new SessionNode(session));
		}
		if (element.kind === 'group') {
			return this.groupChildren(element);
		}
		if (element.kind !== 'session') {
			return [];
		}
		const { session } = element;
		const turn = session.turn ?? session.lastTurn;
		if (!turn) {
			return [];
		}
		const nodes: Node[] = [];
		if (turn.wait) {
			nodes.push(
				new InfoNode(
					session,
					`${turnKey(turn)}:wait`,
					turn.wait.kind === 'question' ? `Asking: ${turn.wait.detail ?? 'a question'}` : turn.wait.detail ?? 'Waiting for you',
					new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground')),
					'Claude cannot continue until you respond.',
					{ command: 'claudePromptMonitor.focusClaude', title: 'Open Claude', arguments: [session.sessionId] }
				)
			);
		}
		if (turn.retry && turn.status === 'running') {
			nodes.push(
				new InfoNode(
					session,
					`${turnKey(turn)}:retry`,
					`Retrying ${turn.retry.attempt}/${turn.retry.max}: ${turn.retry.message}`,
					new vscode.ThemeIcon('sync', new vscode.ThemeColor('list.warningForeground')),
					turn.retry.message
				)
			);
		}
		if (turn.status !== 'running' && turn.status !== 'done' && turn.errorMessage) {
			nodes.push(
				new InfoNode(
					session,
					`${turnKey(turn)}:error`,
					turn.errorMessage,
					new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')),
					turn.errorMessage
				)
			);
		}
		if (taskProgress(session, turn)) {
			nodes.push(new GroupNode(session, turn, 'tasks'));
		}
		if (turnAgents(session, turn).length) {
			nodes.push(new GroupNode(session, turn, 'agents'));
		}
		if (changedFiles(turn).length) {
			nodes.push(new GroupNode(session, turn, 'files'));
		}
		// Newest step first so the current activity is always near the top.
		const steps = turn.steps
			.map((step, index) => new StepNode(session, step, index))
			.reverse()
			.slice(0, 60);
		return [...nodes, ...steps];
	}

	private groupChildren(node: GroupNode): Node[] {
		const { session, turn } = node;
		if (node.group === 'tasks') {
			return (session.todos ?? []).map((todo, index) => new TodoNode(session, todo, index));
		}
		if (node.group === 'agents') {
			return turnAgents(session, turn).map((agent) => new AgentNode(session, agent));
		}
		return changedFiles(turn).map((file) => new FileNode(session, turn, file));
	}

	getTreeItem(node: Node): vscode.TreeItem {
		switch (node.kind) {
			case 'session':
				return this.sessionItem(node);
			case 'info':
				return this.infoItem(node);
			case 'group':
				return this.groupItem(node);
			case 'todo':
				return this.todoItem(node);
			case 'agent':
				return this.agentItem(node);
			case 'file':
				return this.fileItem(node);
			default:
				return this.stepItem(node);
		}
	}

	private sessionItem(node: SessionNode): vscode.TreeItem {
		const { session } = node;
		const turn = session.turn ?? session.lastTurn;
		const title = sessionTitle(session);
		const item = new vscode.TreeItem(
			title ? truncate(title, 60) : projectName(session),
			turn?.steps.length || turn?.wait ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
		);
		item.id = session.sessionId;
		item.contextValue = 'session';
		item.description = `${title ? `${projectName(session)} · ` : ''}${this.sessionDescription(session, turn)}`;
		item.iconPath = sessionIcon(turn);
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
		const now = Date.now();
		if (turn.status === 'running') {
			const state = liveState(turn, now);
			if (state === 'waiting') {
				return `needs you · ${formatClock(now - (turn.wait?.since ?? now))}`;
			}
			if (state === 'background') {
				return 'reply done · agents working';
			}
			if (state === 'retrying' && turn.retry) {
				return `retrying ${turn.retry.attempt}/${turn.retry.max}`;
			}
			const estimate = this.estimator.current(turn, now);
			const eta = `${formatClock(estimate.wallTotalMs)}${estimate.confident ? '' : '?'}`;
			const tasks = taskProgress(session, turn);
			return `${formatClock(now - turn.startedAt)} / ~${eta} · ${turn.toolCount} tools${tasks ? ` · ${tasks.done}/${tasks.total}` : ''}`;
		}
		const duration = (turn.endedAt ?? turn.startedAt) - turn.startedAt;
		const files = describeFiles(fileTotals(changedFiles(turn)));
		return `${turn.status} in ${formatDuration(duration)} · ${turn.toolCount} tools${files ? ` · ${files}` : ''}`;
	}

	private sessionTooltip(session: Session, turn: Turn | undefined): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		const title = sessionTitle(session);
		md.appendMarkdown(`**${title ?? projectName(session)}**\n\n`);
		md.appendMarkdown(`- session: \`${session.sessionId}\`\n`);
		if (session.cwd) {
			md.appendMarkdown(`- cwd: \`${session.cwd}\`\n`);
		}
		if (session.gitBranch) {
			md.appendMarkdown(`- branch: \`${session.gitBranch}\`\n`);
		}
		if (session.entrypoint) {
			md.appendMarkdown(`- via: ${session.entrypoint}\n`);
		}
		if (session.queued) {
			md.appendMarkdown(`- ${session.queued} prompt(s) queued\n`);
		}
		if (turn) {
			md.appendMarkdown(`\n**Prompt**\n\n${truncate(turn.prompt, 400)}\n`);
			if (turn.model) {
				md.appendMarkdown(`\n- model: ${turn.model}`);
			}
			md.appendMarkdown(`\n- output: ${formatTokens(turn.outputTokens)} tokens`);
			if (turn.contextTokens) {
				md.appendMarkdown(`\n- context: ${formatTokens(turn.contextTokens)} tokens`);
			}
			if (turn.waitedMs) {
				md.appendMarkdown(`\n- waited for you: ${formatDuration(turn.waitedMs)}`);
			}
			if (turn.compactions) {
				md.appendMarkdown(`\n- context compacted ${turn.compactions}×`);
			}
		}
		return md;
	}

	private infoItem(node: InfoNode): vscode.TreeItem {
		const item = new vscode.TreeItem(truncate(node.label, 120), vscode.TreeItemCollapsibleState.None);
		item.id = node.id;
		item.iconPath = node.icon;
		item.tooltip = node.tooltip;
		item.command = node.command;
		return item;
	}

	private groupItem(node: GroupNode): vscode.TreeItem {
		const { session, turn } = node;
		let label: string;
		let description = '';
		let icon: string;
		if (node.group === 'tasks') {
			const tasks = taskProgress(session, turn)!;
			label = `Tasks ${tasks.done}/${tasks.total}`;
			description = tasks.current ?? '';
			icon = 'checklist';
		} else if (node.group === 'agents') {
			const agents = turnAgents(session, turn);
			const running = agents.filter((agent) => agent.status === 'running').length;
			label = `Agents (${agents.length})`;
			description = running ? `${running} running` : 'all finished';
			icon = 'organization';
		} else {
			const files = changedFiles(turn);
			const totals = fileTotals(files);
			label = `Changed files (${totals.count})`;
			description = `+${totals.added} −${totals.removed}`;
			icon = 'diff';
		}
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = `${turnKey(turn)}:${node.group}`;
		item.description = description;
		item.iconPath = new vscode.ThemeIcon(icon);
		item.contextValue = `group-${node.group}`;
		if (node.group === 'files') {
			item.tooltip = 'Review what this prompt changed';
		}
		return item;
	}

	private todoItem(node: TodoNode): vscode.TreeItem {
		const { todo } = node;
		const item = new vscode.TreeItem(todo.content, vscode.TreeItemCollapsibleState.None);
		item.id = `${node.session.sessionId}:todo:${node.index}`;
		item.iconPath = new vscode.ThemeIcon(
			todo.status === 'completed' ? 'pass-filled' : todo.status === 'in_progress' ? 'loading~spin' : 'circle-large-outline',
			todo.status === 'completed' ? new vscode.ThemeColor('testing.iconPassed') : undefined
		);
		item.description = todo.status === 'in_progress' ? 'in progress' : undefined;
		return item;
	}

	private agentItem(node: AgentNode): vscode.TreeItem {
		const { agent } = node;
		const item = new vscode.TreeItem(agent.description, vscode.TreeItemCollapsibleState.None);
		item.id = `${node.session.sessionId}:agent:${agent.id}`;
		const state =
			agent.status === 'running' ? (agent.background ? 'background' : 'running') : agent.status === 'failed' ? 'failed' : 'done';
		item.description = [agent.type, state, `${agent.tools} tools`].filter(Boolean).join(' · ');
		item.iconPath = new vscode.ThemeIcon(
			agent.status === 'running' ? 'sync~spin' : agent.status === 'failed' ? 'error' : 'check'
		);
		item.tooltip = agent.lastStep ? `${agent.description}\nlast: ${agent.lastStep}` : agent.description;
		return item;
	}

	private fileItem(node: FileNode): vscode.TreeItem {
		const { file, turn } = node;
		const item = new vscode.TreeItem(vscode.Uri.file(file.path), vscode.TreeItemCollapsibleState.None);
		item.id = `${turnKey(turn)}:file:${file.path}`;
		item.label = path.basename(file.path);
		item.description = `+${file.added} −${file.removed}${file.before?.created ? ' · new' : ''}`;
		item.tooltip = file.path;
		item.iconPath = vscode.ThemeIcon.File;
		item.command = {
			command: 'claudePromptMonitor.openFileChange',
			title: 'Compare with before',
			arguments: [file]
		};
		return item;
	}

	private stepItem(node: StepNode): vscode.TreeItem {
		const { step, session } = node;
		const turn = session.turn ?? session.lastTurn;
		const item = new vscode.TreeItem(step.label, vscode.TreeItemCollapsibleState.None);
		item.id = `${session.sessionId}:${turn?.startedAt ?? 0}:${node.index}`;
		item.contextValue = 'step';
		const pending = step.toolUseId && turn?.status === 'running' ? turn.pending[step.toolUseId] : undefined;
		const offset = turn ? `+${formatClock(step.at - turn.startedAt)}` : '';
		item.description = pending ? `${offset} · running ${formatClock(Date.now() - pending.at)}` : offset;
		item.iconPath = step.failed
			? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
			: new vscode.ThemeIcon(stepIcon(step.label));
		item.tooltip = step.detail ? `${step.label}${step.failed ? ' (failed)' : ''}\n${step.detail}` : step.label;
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

function sessionIcon(turn: Turn | undefined): vscode.ThemeIcon {
	if (!turn) {
		return new vscode.ThemeIcon('circle-outline');
	}
	if (turn.status === 'running') {
		switch (liveState(turn)) {
			case 'waiting':
				return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'));
			case 'background':
				return new vscode.ThemeIcon('organization');
			case 'retrying':
				return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('list.warningForeground'));
			default:
				return new vscode.ThemeIcon('sync~spin');
		}
	}
	switch (turn.status) {
		case 'done':
			return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
		case 'error':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
		case 'limited':
			return new vscode.ThemeIcon('watch', new vscode.ThemeColor('list.warningForeground'));
		case 'interrupted':
			return new vscode.ThemeIcon('debug-stop');
		default:
			return new vscode.ThemeIcon('circle-slash');
	}
}

function stepIcon(label: string): string {
	const name = label.replace('subagent: ', '');
	switch (name) {
		case 'thinking':
			return 'lightbulb';
		case 'message':
			return 'comment';
		case 'hand-back':
			return 'reply';
		case 'compacted':
			return 'fold';
		case 'Read':
		case 'NotebookRead':
			return 'file';
		case 'Edit':
		case 'Write':
		case 'MultiEdit':
		case 'NotebookEdit':
			return 'edit';
		case 'Bash':
		case 'PowerShell':
			return 'terminal';
		case 'Grep':
		case 'Glob':
			return 'search';
		case 'Agent':
		case 'Task':
			return 'organization';
		case 'AskUserQuestion':
			return 'question';
		case 'TodoWrite':
			return 'checklist';
		case 'WebFetch':
		case 'WebSearch':
			return 'globe';
		default:
			return 'tools';
	}
}
