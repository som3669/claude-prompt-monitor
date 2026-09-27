import * as path from 'path';
import { formatTimeOfDay, truncate } from './format';
import { activeMs, holdingAgents } from './turnTracker';
import { AgentInfo, FileChange, Session, Turn, TurnSummary } from './types';

/**
 * What a running turn is doing, from the user's point of view. `waiting` outranks everything: it is
 * the one state where Claude cannot continue until the user acts.
 */
export type LiveState = 'waiting' | 'retrying' | 'working' | 'background';

const STATE_RANK: Record<LiveState, number> = { waiting: 0, retrying: 1, working: 2, background: 3 };

export function liveState(turn: Turn, now = Date.now()): LiveState {
	if (turn.wait) {
		return 'waiting';
	}
	if (turn.phase === 'background') {
		return 'background';
	}
	// A retry is only current until the next attempt has had a fair chance to answer.
	if (turn.retry && now - turn.retry.retryAt < 60_000) {
		return 'retrying';
	}
	return 'working';
}

/** Most urgent first, then the one waited on longest. */
export function byUrgency<T extends { turn: Turn }>(items: T[], now = Date.now()): T[] {
	return [...items].sort((a, b) => {
		const rank = STATE_RANK[liveState(a.turn, now)] - STATE_RANK[liveState(b.turn, now)];
		return rank !== 0 ? rank : a.turn.startedAt - b.turn.startedAt;
	});
}

export function projectName(session: Session): string {
	return session.cwd ? path.basename(session.cwd) : session.sessionId.slice(0, 8);
}

/** The conversation's title when Claude Code has one, which says more than the folder name. */
export function sessionTitle(session: Session): string | undefined {
	return session.customTitle || session.title;
}

export function waitVerb(turn: Turn): string {
	switch (turn.wait?.kind) {
		case 'question':
			return 'is asking you';
		case 'plan':
			return 'wants a plan approved';
		case 'permission':
			return 'needs permission';
		default:
			return 'needs your input';
	}
}

export interface CurrentStep {
	label: string;
	detail?: string;
	/** How long the step's tool call has been running, when it has not returned yet. */
	runningMs?: number;
}

export function currentStep(turn: Turn, now = Date.now()): CurrentStep {
	const step = turn.steps[turn.steps.length - 1];
	if (!step) {
		return { label: 'thinking' };
	}
	const pending = step.toolUseId ? turn.pending[step.toolUseId] : undefined;
	return { label: step.label, detail: step.detail, runningMs: pending ? now - pending.at : undefined };
}

export interface TaskProgress {
	done: number;
	total: number;
	current?: string;
}

/** Progress through Claude's own task list, when it keeps one for this turn. */
export function taskProgress(session: Session, turn: Turn): TaskProgress | undefined {
	const todos = session.todos;
	if (!todos?.length) {
		return undefined;
	}
	// Only a list written during this turn. One left open by an interrupted prompt is not this prompt's
	// progress; if Claude carries on with it, it rewrites the list within moments and it shows again.
	if ((session.todosAt ?? 0) < turn.startedAt) {
		return undefined;
	}
	const active = todos.find((todo) => todo.status === 'in_progress');
	return {
		done: todos.filter((todo) => todo.status === 'completed').length,
		total: todos.length,
		current: active ? active.activeForm || active.content : undefined
	};
}

export function turnAgents(session: Session, turn: Turn): AgentInfo[] {
	return turn.agentIds.map((id) => session.agents[id]).filter((agent): agent is AgentInfo => !!agent);
}

/** Background agents the turn is still waiting on, while its reply has ended. */
export function backgroundAgents(session: Session, turn: Turn, now = Date.now()): AgentInfo[] {
	return holdingAgents(session, turn, now);
}

export interface FileTotals {
	count: number;
	added: number;
	removed: number;
}

export function fileTotals(files: FileChange[]): FileTotals {
	return files.reduce(
		(totals, file) => ({
			count: totals.count + 1,
			added: totals.added + file.added,
			removed: totals.removed + file.removed
		}),
		{ count: 0, added: 0, removed: 0 }
	);
}

export function changedFiles(turn: Turn): FileChange[] {
	// A backup with no edit behind it (a tool that failed) is not a change.
	return Object.values(turn.files).filter((file) => file.edits > 0 || file.added > 0 || file.removed > 0);
}

export function describeFiles(totals: FileTotals): string {
	if (!totals.count) {
		return '';
	}
	const lines = totals.added || totals.removed ? ` (+${totals.added} −${totals.removed})` : '';
	return `${totals.count} ${totals.count === 1 ? 'file' : 'files'}${lines}`;
}

/** The first sentence or line of Claude's closing message, for a notification body. */
export function headline(text: string | undefined, max = 160): string | undefined {
	if (!text) {
		return undefined;
	}
	const plain = text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/[*_`#>]/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.trim();
	const firstLine = plain.split(/\n+/).find((line) => line.trim().length > 0) ?? '';
	const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine.trim());
	const picked = (sentence ? sentence[1] : firstLine).replace(/\s+/g, ' ').trim();
	if (!picked) {
		return undefined;
	}
	return picked.length > max ? `${picked.slice(0, max - 1)}…` : picked;
}

export function turnKey(turn: Turn): string {
	return `${turn.sessionId}:${turn.startedAt}`;
}

export function summarize(session: Session, turn: Turn): TurnSummary {
	const tasks = taskProgress(session, turn);
	return {
		key: turnKey(turn),
		sessionId: session.sessionId,
		project: projectName(session),
		title: sessionTitle(session),
		prompt: turn.prompt.slice(0, 600),
		trigger: turn.trigger,
		status: turn.status,
		startedAt: turn.startedAt,
		endedAt: turn.endedAt ?? turn.startedAt,
		activeMs: activeMs(turn),
		waitedMs: turn.waitedMs,
		tools: turn.toolCount,
		errors: turn.errorCount,
		outputTokens: turn.outputTokens,
		model: turn.model,
		files: changedFiles(turn),
		agents: turn.agentIds.length,
		tasksDone: tasks?.done,
		tasksTotal: tasks?.total,
		finalText: turn.finalText?.slice(0, 1200),
		errorMessage: turn.errorMessage,
		limitResetsAt: turn.limitResetsAt,
		transcript: session.file
	};
}

/** Turns the raw API error into what to do about it. */
export function errorAdvice(turn: Pick<Turn, 'status' | 'errorMessage' | 'limitResetsAt'>): string {
	const message = turn.errorMessage ?? '';
	if (turn.status === 'limited') {
		if (turn.limitResetsAt) {
			return `resets at ${formatTimeOfDay(turn.limitResetsAt)}.`;
		}
		return truncate(message.replace(/^You've hit your /i, 'Reached your '), 120);
	}
	if (/authenticat|oauth|401|log ?in/i.test(message)) {
		return 'sign-in expired — run /login in Claude Code, then send the prompt again.';
	}
	if (/overloaded|529|500|502|503|internal server/i.test(message)) {
		return "Anthropic's API was overloaded — try again in a moment.";
	}
	if (/prompt is too long|context/i.test(message)) {
		return 'the conversation is too long — run /compact or start a new one.';
	}
	if (/image/i.test(message)) {
		return 'an image could not be processed and was removed.';
	}
	if (/connect|ENOTFOUND|ECONNRESET|network|timed out|SSL/i.test(message)) {
		return 'could not reach the API — check the connection.';
	}
	return truncate(message.replace(/^API Error:\s*/i, ''), 140) || 'an API error ended the turn.';
}
