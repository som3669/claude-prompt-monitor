import * as path from 'path';
import * as vscode from 'vscode';
import { EntryEvent } from './transcriptWatcher';
import { ContentBlock, Session, Step, TranscriptEntry, Turn } from './types';

export interface TurnEvent {
	session: Session;
	turn: Turn;
}

/**
 * Turns a stream of transcript entries into per-session turns.
 *
 * A turn starts at a human prompt (`type: "user"` with `origin.kind: "human"`) and ends at the
 * assistant message that stops with `end_turn` — the same boundary Claude Code uses for its own
 * Stop hook.
 */
export class TurnTracker implements vscode.Disposable {
	private readonly sessions = new Map<string, Session>();

	private readonly started = new vscode.EventEmitter<TurnEvent>();
	private readonly updated = new vscode.EventEmitter<TurnEvent>();
	private readonly ended = new vscode.EventEmitter<TurnEvent>();

	readonly onTurnStarted = this.started.event;
	readonly onTurnUpdated = this.updated.event;
	readonly onTurnEnded = this.ended.event;

	/** When false the entry is still tracked, but callers are told not to notify. */
	constructor(private readonly inScope: (cwd: string | undefined) => boolean = () => true) {}

	getSessions(): Session[] {
		return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	}

	getActiveTurns(): TurnEvent[] {
		return this.getSessions()
			.filter((s) => s.turn?.status === 'running')
			.map((s) => ({ session: s, turn: s.turn! }));
	}

	handle({ file, entry }: EntryEvent): void {
		const sessionId = entry.sessionId;
		if (!sessionId) {
			return;
		}
		const at = toMillis(entry.timestamp);
		const session = this.session(sessionId, file, entry, at);

		if (entry.type === 'user') {
			this.handleUser(session, entry, at);
			return;
		}
		if (entry.type === 'assistant') {
			this.handleAssistant(session, entry, at);
		}
	}

	private session(sessionId: string, file: string, entry: TranscriptEntry, at: number): Session {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = { sessionId, file, lastSeenAt: at };
			this.sessions.set(sessionId, session);
		}
		session.file = file;
		session.lastSeenAt = Math.max(session.lastSeenAt, at);
		if (entry.cwd) {
			session.cwd = entry.cwd;
		}
		if (entry.gitBranch) {
			session.gitBranch = entry.gitBranch;
		}
		if (entry.entrypoint) {
			session.entrypoint = entry.entrypoint;
		}
		return session;
	}

	private handleUser(session: Session, entry: TranscriptEntry, at: number): void {
		const isHumanPrompt = entry.origin?.kind === 'human' && !entry.isSidechain;
		if (isHumanPrompt) {
			// A new prompt while one is still running means the previous turn never reported an end.
			if (session.turn?.status === 'running') {
				this.finish(session, at, 'abandoned');
			}
			const turn: Turn = {
				sessionId: session.sessionId,
				project: projectKey(session.cwd),
				promptId: entry.promptId,
				prompt: promptText(entry),
				startedAt: at,
				status: 'running',
				steps: [],
				toolCount: 0,
				outputTokens: 0,
				lastActivityAt: at
			};
			session.turn = turn;
			this.started.fire({ session, turn });
			return;
		}

		// Tool results and subagent chatter: proof the turn is still moving.
		const turn = session.turn;
		if (turn?.status === 'running') {
			turn.lastActivityAt = at;
			this.updated.fire({ session, turn });
		}
	}

	private handleAssistant(session: Session, entry: TranscriptEntry, at: number): void {
		const turn = session.turn;
		if (!turn || turn.status !== 'running') {
			return;
		}
		turn.lastActivityAt = at;

		if (entry.message?.model && entry.message.model !== '<synthetic>') {
			turn.model = entry.message.model;
		}
		turn.outputTokens += entry.message?.usage?.output_tokens ?? 0;

		const blocks = Array.isArray(entry.message?.content) ? (entry.message!.content as ContentBlock[]) : [];
		for (const block of blocks) {
			const step = describeBlock(block, at, !!entry.isSidechain);
			if (step) {
				turn.steps.push(step);
				if (block.type === 'tool_use') {
					turn.toolCount += 1;
				}
			}
		}

		if (entry.isApiErrorMessage) {
			this.finish(session, at, 'error');
			return;
		}
		// Sidechain (subagent) messages end their own turn, never the user's.
		if (!entry.isSidechain && entry.message?.stop_reason === 'end_turn') {
			this.finish(session, at, 'done');
			return;
		}
		this.updated.fire({ session, turn });
	}

	/** Marks turns as abandoned once their transcript has gone quiet for too long. */
	sweep(): void {
		const staleMinutes =
			vscode.workspace.getConfiguration('claudePromptMonitor').get<number>('staleTurnMinutes') ?? 30;
		const cutoff = Date.now() - staleMinutes * 60_000;
		for (const session of this.sessions.values()) {
			if (session.turn?.status === 'running' && session.turn.lastActivityAt < cutoff) {
				this.finish(session, session.turn.lastActivityAt, 'abandoned');
			}
		}
	}

	private finish(session: Session, at: number, status: Turn['status']): void {
		const turn = session.turn;
		if (!turn || turn.status !== 'running') {
			return;
		}
		turn.status = status;
		turn.endedAt = Math.max(at, turn.startedAt);
		session.lastTurn = turn;
		session.turn = undefined;
		this.ended.fire({ session, turn });
	}

	isInScope(session: Session): boolean {
		return this.inScope(session.cwd);
	}

	dispose(): void {
		this.started.dispose();
		this.updated.dispose();
		this.ended.dispose();
	}
}

export function projectKey(cwd: string | undefined): string {
	return cwd ? path.resolve(cwd).toLowerCase() : 'unknown';
}

function toMillis(timestamp: string | undefined): number {
	const parsed = timestamp ? Date.parse(timestamp) : NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function promptText(entry: TranscriptEntry): string {
	const content = entry.message?.content;
	if (typeof content === 'string') {
		return clean(content);
	}
	if (Array.isArray(content)) {
		const text = content
			.filter((b) => b.type === 'text' && b.text)
			.map((b) => b.text!)
			.join(' ');
		if (text) {
			return clean(text);
		}
		if (content.some((b) => b.type === 'image')) {
			return '(image prompt)';
		}
	}
	return '(prompt)';
}

function clean(text: string): string {
	return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function describeBlock(block: ContentBlock, at: number, isSidechain: boolean): Step | undefined {
	const prefix = isSidechain ? 'subagent: ' : '';
	if (block.type === 'tool_use') {
		return { label: prefix + (block.name || 'tool'), at, detail: toolDetail(block) };
	}
	if (block.type === 'thinking') {
		return { label: prefix + 'thinking', at };
	}
	if (block.type === 'text' && block.text && block.text.trim()) {
		return { label: prefix + 'message', at, detail: clean(block.text).slice(0, 120) };
	}
	return undefined;
}

function toolDetail(block: ContentBlock): string | undefined {
	const input = block.input as Record<string, unknown> | undefined;
	if (!input || typeof input !== 'object') {
		return undefined;
	}
	for (const key of ['file_path', 'path', 'pattern', 'command', 'description', 'prompt', 'url']) {
		const value = input[key];
		if (typeof value === 'string' && value.trim()) {
			return value.replace(/\s+/g, ' ').slice(0, 120);
		}
	}
	return undefined;
}
