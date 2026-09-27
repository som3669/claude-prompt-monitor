import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EntryEvent } from './transcriptWatcher';
import {
	AgentInfo,
	ContentBlock,
	FileChange,
	Session,
	Step,
	TodoItem,
	TranscriptEntry,
	Turn,
	TurnStatus,
	TurnTrigger,
	Wait,
	WaitKind
} from './types';

export interface TurnEvent {
	session: Session;
	turn: Turn;
	/** True while replaying transcript history after a reload: update views, but do not notify or learn. */
	replay: boolean;
}

export interface WaitEvent extends TurnEvent {
	wait: Wait;
}

export interface TrackerOptions {
	/** When false the entry is still tracked, but callers are told not to notify. */
	inScope?: (cwd: string | undefined) => boolean;
	/** Claude Code's home, used to locate its file-history backups. */
	claudeHome?: () => string;
	staleMinutes?: () => number;
}

const INTERRUPT_MARKER = '[Request interrupted by user';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_COUNTED_MESSAGES = 200;
/** How long a finished background agent's report may take to reach the session: ~30s, longer behind a slow Stop hook. */
const HANDBACK_GRACE_MS = 180_000;

/**
 * Turns a stream of transcript entries into per-session turns.
 *
 * A turn starts at a human prompt (`type: "user"` with `origin.kind: "human"`), or at a background
 * task or agent hand-back when nothing is running, and ends at the assistant message that stops with
 * `end_turn` — the same boundary Claude Code uses for its own Stop hook. An interrupt, an API error
 * or a usage limit ends it too. While background agents are still working the turn stays open in the
 * `background` phase, because Claude resumes it when they hand back.
 */
export class TurnTracker implements vscode.Disposable {
	private readonly sessions = new Map<string, Session>();
	private readonly agentMetaCache = new Map<string, AgentMeta | undefined>();
	/** True while handling an entry replayed from history; carried onto every event it causes. */
	private replaying = false;

	private readonly started = new vscode.EventEmitter<TurnEvent>();
	private readonly updated = new vscode.EventEmitter<TurnEvent>();
	private readonly ended = new vscode.EventEmitter<TurnEvent>();
	private readonly waiting = new vscode.EventEmitter<WaitEvent>();

	readonly onTurnStarted = this.started.event;
	readonly onTurnUpdated = this.updated.event;
	readonly onTurnEnded = this.ended.event;
	/** Claude has just become blocked on the user. */
	readonly onWaitStarted = this.waiting.event;

	private readonly inScope: (cwd: string | undefined) => boolean;
	private readonly claudeHome?: () => string;
	private readonly staleMinutes: () => number;

	constructor(options: TrackerOptions = {}) {
		this.inScope = options.inScope ?? (() => true);
		this.claudeHome = options.claudeHome;
		this.staleMinutes = options.staleMinutes ?? (() => 30);
	}

	getSessions(): Session[] {
		return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	}

	getSession(sessionId: string): Session | undefined {
		return this.sessions.get(sessionId);
	}

	getActiveTurns(): { session: Session; turn: Turn }[] {
		return this.getSessions()
			.filter((s) => s.turn?.status === 'running')
			.map((s) => ({ session: s, turn: s.turn! }));
	}

	/** Sessions whose subagent transcripts are worth watching: busy now, or active a moment ago. */
	hotSessions(now = Date.now()): Session[] {
		return this.getSessions().filter(
			(s) => !!s.turn || runningAgents(s).length > 0 || now - s.lastSeenAt < 120_000
		);
	}

	handle(event: EntryEvent): void {
		const previous = this.replaying;
		this.replaying = previous || !!event.replay;
		try {
			this.process(event.file, event.entry);
		} finally {
			this.replaying = previous;
		}
	}

	private process(file: string, entry: TranscriptEntry): void {
		const sessionId = entry.sessionId || sessionIdFromFile(file);
		if (!sessionId) {
			return;
		}
		const at = entry.timestamp ? toMillis(entry.timestamp) : undefined;
		const session = this.session(sessionId, file, entry, at);
		const when = at ?? Date.now();

		if (entry.isSidechain && entry.agentId) {
			this.handleAgentEntry(session, entry, when, file);
			return;
		}

		switch (entry.type) {
			case 'user':
				this.handleUser(session, entry, when);
				return;
			case 'assistant':
				this.handleAssistant(session, entry, when);
				return;
			case 'system':
				this.handleSystem(session, entry, when);
				return;
			case 'ai-title':
				if (entry.aiTitle) {
					session.title = clean(entry.aiTitle);
				}
				return;
			case 'custom-title':
				if (entry.customTitle) {
					session.customTitle = clean(entry.customTitle);
				}
				return;
			case 'queue-operation':
				this.handleQueue(session, entry);
				return;
			case 'permission-mode':
				session.permissionMode = entry.permissionMode;
				return;
			case 'cost-state':
				if (typeof entry.totalCostUSD === 'number') {
					session.costUSD = entry.totalCostUSD;
				}
				return;
			case 'file-history-delta':
				this.handleFileBackup(session, entry);
				return;
		}
	}

	/**
	 * A signal from the optional Notification hook: Claude Code is showing a permission prompt or
	 * otherwise waiting on input. The transcript records nothing until the user answers, so this is
	 * the only exact source for permission prompts.
	 */
	hookWait(sessionId: string, kind: WaitKind, detail: string | undefined, at: number): void {
		const session = this.sessions.get(sessionId);
		const turn = session?.turn;
		if (!session || !turn || turn.status !== 'running' || turn.wait) {
			return;
		}
		// Anything the transcript wrote after the hook fired means the prompt was already answered.
		if (turn.lastActivityAt > at + 500) {
			return;
		}
		this.openWait(session, turn, { kind, since: at, detail, source: 'hook' });
	}

	private session(sessionId: string, file: string, entry: TranscriptEntry, at: number | undefined): Session {
		let session = this.sessions.get(sessionId);
		const isSubagentFile = isSubagentTranscript(file);
		if (!session) {
			session = {
				sessionId,
				file: isSubagentFile ? mainTranscriptFor(file, sessionId) : file,
				lastSeenAt: at ?? 0,
				agents: {},
				queued: 0
			};
			this.sessions.set(sessionId, session);
		}
		if (!isSubagentFile) {
			session.file = file;
		}
		if (at !== undefined) {
			session.lastSeenAt = Math.max(session.lastSeenAt, at);
		}
		if (entry.cwd && !isSubagentFile) {
			session.cwd = entry.cwd;
		}
		if (entry.gitBranch && !isSubagentFile) {
			session.gitBranch = entry.gitBranch;
		}
		if (entry.entrypoint) {
			session.entrypoint = entry.entrypoint;
		}
		return session;
	}

	// ------------------------------------------------------------------ user entries

	private handleUser(session: Session, entry: TranscriptEntry, at: number): void {
		if (entry.isSidechain) {
			// Old transcripts wrote subagent chatter inline; it is proof of life and nothing more.
			this.touch(session, at);
			return;
		}
		const kind = entry.origin?.kind;
		const text = textOf(entry);

		if (kind === 'human') {
			this.startHumanTurn(session, entry, at);
			return;
		}

		if (text.startsWith(INTERRUPT_MARKER)) {
			session.pendingAutomatic = undefined;
			const turn = session.turn;
			// Once the reply has ended the marker comes from a Stop hook cancelled by the next message,
			// not from the user stopping Claude, so a turn waiting on background agents ignores it.
			if (turn?.status === 'running' && turn.phase !== 'background') {
				this.finish(session, at, 'interrupted', 'interrupt');
			}
			return;
		}

		if (kind === 'task-notification' || kind === 'peer') {
			this.handleAutomaticPrompt(session, entry, text, kind === 'peer' ? 'peer' : 'background', at);
			return;
		}

		const turn = session.turn;
		if (turn?.status !== 'running') {
			return;
		}
		this.resumeIfBackground(turn);
		turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
		if (turn.wait?.source === 'hook' && at > turn.wait.since) {
			this.closeWait(turn, at);
		}
		const blocks = Array.isArray(entry.message?.content) ? (entry.message!.content as ContentBlock[]) : [];
		for (const block of blocks) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				this.handleToolResult(session, turn, block, entry, at);
			}
		}
		this.updated.fire(this.event(session, turn));
	}

	private startHumanTurn(session: Session, entry: TranscriptEntry, at: number): void {
		const previous = session.turn;
		if (previous?.status === 'running') {
			if (previous.phase === 'background') {
				// The reply had ended; only background agents were outstanding. The user is back.
				this.finish(session, previous.lastReplyEndedAt ?? previous.lastActivityAt, 'done', 'next-prompt');
			} else {
				// A new prompt while one is still running means the previous turn never reported an end.
				this.finish(session, at, 'abandoned', 'next-prompt');
			}
		}
		session.pendingAutomatic = undefined;
		const turn = newTurn(session, 'human', promptText(entry), at, entry.promptId);
		session.turn = turn;
		this.started.fire(this.event(session, turn));
	}

	/** A background task finished, or another session (an agent) handed its report back. */
	private handleAutomaticPrompt(
		session: Session,
		entry: TranscriptEntry,
		text: string,
		trigger: TurnTrigger,
		at: number
	): void {
		const handedBack = trigger === 'peer' ? parseHandBack(text) : undefined;
		const task = trigger === 'background' ? parseTaskNotification(text) : undefined;
		const agentId = handedBack ?? task?.id;
		const agent = agentId ? session.agents[agentId] : undefined;
		if (agent) {
			agent.handedBack = true;
			if (agent.status === 'running') {
				agent.status = task && /fail|kill|error/i.test(task.status ?? '') ? 'failed' : 'done';
				agent.endedAt = at;
				agent.lastActivityAt = at;
			}
		}

		const label = agent
			? `${trigger === 'peer' ? 'Agent reported back' : 'Agent finished'}: ${agent.description}`
			: task?.summary
				? `Background task: ${task.summary}`
				: trigger === 'peer'
					? 'Message from another session'
					: 'Background task finished';

		const turn = session.turn;
		if (turn?.status === 'running') {
			this.resumeIfBackground(turn);
			turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
			turn.steps.push({ label: 'hand-back', at, detail: truncateText(label, 120) });
			this.updated.fire(this.event(session, turn));
			return;
		}
		// Not a turn yet: some notifications (stale tasks on resume) are only folded into the next
		// prompt and never answered. It becomes one when Claude actually replies to it.
		session.pendingAutomatic = { trigger, label, at, promptId: entry.promptId };
	}

	private startAutomaticTurn(session: Session): Turn | undefined {
		const pending = session.pendingAutomatic;
		session.pendingAutomatic = undefined;
		if (!pending) {
			return undefined;
		}
		const turn = newTurn(session, pending.trigger, pending.label, pending.at, pending.promptId);
		session.turn = turn;
		this.started.fire(this.event(session, turn));
		return turn;
	}

	private handleToolResult(session: Session, turn: Turn, block: ContentBlock, entry: TranscriptEntry, at: number): void {
		const id = block.tool_use_id!;
		const pending = turn.pending[id];
		delete turn.pending[id];
		if (turn.wait?.toolUseId === id) {
			this.closeWait(turn, at);
		}
		if (block.is_error) {
			turn.errorCount += 1;
			const step = findStep(turn, id);
			if (step) {
				step.failed = true;
			}
		}

		const result = entry.toolUseResult;
		if (!result || typeof result !== 'object') {
			return;
		}
		const record = result as Record<string, unknown>;

		if (pending && (pending.name === 'Agent' || pending.name === 'Task')) {
			const agentId = typeof record.agentId === 'string' ? record.agentId : undefined;
			const agent = agentId ? this.linkAgent(session, turn, agentId, id) : session.agents[id];
			if (!agent) {
				return;
			}
			if (record.isAsync === true) {
				agent.background = true;
			} else if (agent.status === 'running') {
				// A foreground agent: the result is its report, so it is done.
				agent.status = block.is_error ? 'failed' : 'done';
				agent.endedAt = at;
			}
			return;
		}

		const filePath = typeof record.filePath === 'string' ? record.filePath : undefined;
		if (filePath && Array.isArray(record.structuredPatch)) {
			const change = fileChange(turn, filePath);
			let added = 0;
			let removed = 0;
			for (const hunk of record.structuredPatch as { lines?: unknown }[]) {
				for (const line of Array.isArray(hunk?.lines) ? (hunk.lines as unknown[]) : []) {
					if (typeof line !== 'string') {
						continue;
					}
					if (line.startsWith('+')) {
						added += 1;
					} else if (line.startsWith('-')) {
						removed += 1;
					}
				}
			}
			if (record.type === 'create' && added === 0 && typeof record.content === 'string') {
				added = record.content.split('\n').length;
			}
			if (record.type === 'create' && !change.before) {
				change.before = { created: true };
			}
			change.added += added;
			change.removed += removed;
		}
	}

	// ------------------------------------------------------------------ assistant entries

	private handleAssistant(session: Session, entry: TranscriptEntry, at: number): void {
		if (entry.isSidechain) {
			this.handleInlineSidechain(session, entry, at);
			return;
		}
		const message = entry.message;
		const synthetic = message?.model === '<synthetic>';
		const turn =
			session.turn?.status === 'running' ? session.turn : synthetic ? undefined : this.startAutomaticTurn(session);
		if (!turn) {
			return;
		}
		this.resumeIfBackground(turn);
		turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
		if (message?.model && !synthetic) {
			turn.model = message.model;
			turn.retry = undefined; // a real reply means the API call went through
		}
		if (turn.wait?.source === 'hook' && at > turn.wait.since) {
			this.closeWait(turn, at);
		}

		// Claude Code writes one entry per content block, each carrying the whole message's usage.
		const messageId = message?.id;
		if (messageId && !turn.countedMessages.includes(messageId)) {
			turn.countedMessages.push(messageId);
			if (turn.countedMessages.length > MAX_COUNTED_MESSAGES) {
				turn.countedMessages.shift();
			}
			const usage = message?.usage;
			turn.outputTokens += usage?.output_tokens ?? 0;
			const context =
				(usage?.input_tokens ?? 0) +
				(usage?.cache_creation_input_tokens ?? 0) +
				(usage?.cache_read_input_tokens ?? 0);
			if (context > 0) {
				turn.contextTokens = context;
			}
		}

		const blocks = Array.isArray(message?.content) ? (message!.content as ContentBlock[]) : [];
		for (const block of blocks) {
			if (block.type === 'tool_use') {
				this.handleToolUse(session, turn, block, at);
				continue;
			}
			const step = describeBlock(block, at, '');
			if (step) {
				turn.steps.push(step);
			}
			if (block.type === 'text' && block.text && block.text.trim() && !synthetic) {
				turn.finalText = block.text.trim().slice(0, 1200);
			}
		}

		if (entry.isApiErrorMessage) {
			const text = textOf(entry);
			const limited = entry.error === 'rate_limit' || entry.quotaLimits?.status === 'rejected';
			if (limited) {
				const resetsAt = entry.quotaLimits?.resetsAt ? entry.quotaLimits.resetsAt * 1000 : undefined;
				turn.limitResetsAt = resetsAt;
				session.limitResetsAt = resetsAt;
				turn.errorMessage = text || 'Usage limit reached';
				this.finish(session, at, 'limited', 'error');
			} else {
				turn.errorMessage = text || 'API error';
				this.finish(session, at, 'error', 'error');
			}
			return;
		}
		const stop = message?.stop_reason;
		if (stop === 'end_turn' || (synthetic && stop === 'stop_sequence')) {
			this.replyEnded(session, turn, at);
			return;
		}
		this.updated.fire(this.event(session, turn));
	}

	private handleToolUse(session: Session, turn: Turn, block: ContentBlock, at: number): void {
		const id = block.id ?? `tool-${turn.steps.length}`;
		const name = block.name || 'tool';
		turn.toolCount += 1;
		turn.pending[id] = { name, at };
		turn.steps.push({ label: name, at, detail: toolDetail(block), toolUseId: id });
		const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;

		if (name === 'AskUserQuestion') {
			this.openWait(session, turn, {
				kind: 'question',
				since: at,
				detail: firstQuestion(input),
				toolUseId: id,
				source: 'transcript'
			});
		} else if (name === 'ExitPlanMode') {
			this.openWait(session, turn, {
				kind: 'plan',
				since: at,
				detail: 'A plan is ready for your approval',
				toolUseId: id,
				source: 'transcript'
			});
		} else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
			session.todos = (input.todos as unknown[])
				.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
				.map((t) => ({
					content: String(t.content ?? ''),
					status: String(t.status ?? 'pending'),
					activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined
				}));
			session.todosAt = at;
		} else if (name === 'Agent' || name === 'Task') {
			const description = typeof input.description === 'string' ? input.description : 'agent';
			const type = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
			// The agent's own transcript may have been read first, already linked to this call.
			const known = Object.values(session.agents).find((agent) => agent.toolUseId === id);
			if (known) {
				known.description = known.description === 'agent' ? description : known.description;
				known.type = known.type ?? type;
				if (!turn.agentIds.includes(known.id)) {
					turn.agentIds.push(known.id);
				}
			} else {
				session.agents[id] = {
					id,
					toolUseId: id,
					description,
					type,
					background: input.run_in_background === true,
					status: 'running',
					startedAt: at,
					lastActivityAt: at,
					tools: 0
				};
				turn.agentIds.push(id);
			}
		} else if (EDIT_TOOLS.has(name)) {
			const target =
				typeof input.file_path === 'string'
					? input.file_path
					: typeof input.notebook_path === 'string'
						? input.notebook_path
						: undefined;
			if (target) {
				fileChange(turn, target).edits += 1;
			}
		}
	}

	/** The main reply ended. If background agents it launched are still out, the turn waits for them. */
	private replyEnded(session: Session, turn: Turn, at: number): void {
		if (this.heldOpen(session, turn, at)) {
			turn.phase = 'background';
			turn.lastReplyEndedAt = at;
			this.updated.fire(this.event(session, turn));
			return;
		}
		this.finish(session, at, 'done', 'reply');
	}

	private handleInlineSidechain(session: Session, entry: TranscriptEntry, at: number): void {
		const turn = session.turn;
		if (!turn || turn.status !== 'running') {
			return;
		}
		turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
		const blocks = Array.isArray(entry.message?.content) ? (entry.message!.content as ContentBlock[]) : [];
		for (const block of blocks) {
			const step = describeBlock(block, at, 'subagent: ');
			if (step) {
				turn.steps.push(step);
			}
		}
		this.updated.fire(this.event(session, turn));
	}

	// ------------------------------------------------------------------ agents (subagent transcripts)

	private handleAgentEntry(session: Session, entry: TranscriptEntry, at: number, file: string): void {
		const agentId = entry.agentId!;
		let agent = session.agents[agentId];
		if (!agent) {
			const meta = this.agentMeta(file);
			agent = {
				id: agentId,
				toolUseId: meta?.toolUseId,
				description: meta?.description ?? 'agent',
				type: meta?.agentType,
				background: meta?.requestShape === 'background',
				status: 'running',
				startedAt: at,
				lastActivityAt: at,
				tools: 0
			};
			session.agents[agentId] = agent;
			if (meta?.toolUseId) {
				this.linkAgent(session, session.turn, agentId, meta.toolUseId);
				agent = session.agents[agentId];
			}
		}
		agent.lastActivityAt = Math.max(agent.lastActivityAt, at);
		if (entry.type === 'assistant') {
			const blocks = Array.isArray(entry.message?.content) ? (entry.message!.content as ContentBlock[]) : [];
			for (const block of blocks) {
				if (block.type === 'tool_use') {
					if (agent.status === 'done') {
						agent.status = 'running'; // sent another message, and working again
						agent.endedAt = undefined;
					}
					agent.tools += 1;
					const detail = toolDetail(block);
					agent.lastStep = detail ? `${block.name} · ${detail}` : block.name;
				}
			}
			// The agent's own reply ending is the end of its work; the hand-back follows shortly.
			if (entry.message?.stop_reason === 'end_turn' && agent.status === 'running') {
				agent.status = 'done';
				agent.endedAt = at;
			}
		}
		const turn = session.turn;
		if (turn?.status === 'running') {
			// A turn is alive while its agents work, even when the main transcript is quiet.
			turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
			this.updated.fire(this.event(session, turn));
		}
	}

	/**
	 * Joins the two halves of an agent: the Agent tool call in the parent transcript (keyed by its
	 * tool-use id) and the agent's own transcript (keyed by agent id). Either can be read first.
	 */
	private linkAgent(session: Session, turn: Turn | undefined, agentId: string, toolUseId: string): AgentInfo {
		const placeholder = toolUseId !== agentId ? session.agents[toolUseId] : undefined;
		const existing = session.agents[agentId];
		const base = existing ?? placeholder;
		const agent: AgentInfo = base
			? { ...base }
			: {
					id: agentId,
					description: 'agent',
					background: false,
					status: 'running',
					startedAt: Date.now(),
					lastActivityAt: Date.now(),
					tools: 0
				};
		if (existing && placeholder) {
			if (placeholder.description !== 'agent') {
				agent.description = placeholder.description;
			}
			agent.type = placeholder.type ?? existing.type;
			agent.background = existing.background || placeholder.background;
			agent.startedAt = Math.min(existing.startedAt, placeholder.startedAt);
		}
		agent.id = agentId;
		agent.toolUseId = toolUseId;
		if (placeholder) {
			delete session.agents[toolUseId];
		}
		session.agents[agentId] = agent;
		for (const owner of [turn, session.turn, session.lastTurn]) {
			if (!owner) {
				continue;
			}
			const index = owner.agentIds.indexOf(toolUseId);
			if (index >= 0) {
				owner.agentIds[index] = agentId;
			}
		}
		return agent;
	}

	private agentMeta(file: string): AgentMeta | undefined {
		const metaFile = file.replace(/\.jsonl$/i, '.meta.json');
		if (this.agentMetaCache.has(metaFile)) {
			return this.agentMetaCache.get(metaFile);
		}
		let meta: AgentMeta | undefined;
		try {
			meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as AgentMeta;
		} catch {
			meta = undefined;
		}
		this.agentMetaCache.set(metaFile, meta);
		return meta;
	}

	// ------------------------------------------------------------------ other entries

	private handleSystem(session: Session, entry: TranscriptEntry, at: number): void {
		const turn = session.turn;
		if (entry.subtype === 'api_error') {
			if (turn?.status !== 'running') {
				return;
			}
			const error = (entry.error ?? {}) as { formatted?: string; message?: string };
			turn.retry = {
				message: clean(String(error.formatted || error.message || 'API error')).slice(0, 160),
				attempt: entry.retryAttempt ?? 1,
				max: entry.maxRetries ?? 10,
				at,
				retryAt: at + (entry.retryInMs ?? 0)
			};
			turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
			this.updated.fire(this.event(session, turn));
			return;
		}
		if (entry.subtype === 'compact_boundary' && turn?.status === 'running') {
			const meta = entry.compactMetadata;
			turn.compactions += 1;
			turn.steps.push({
				label: 'compacted',
				at,
				detail: [meta?.trigger, meta?.preTokens ? `${Math.round(meta.preTokens / 1000)}k tokens before` : '']
					.filter(Boolean)
					.join(' · ')
			});
			turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
			this.updated.fire(this.event(session, turn));
		}
	}

	private handleQueue(session: Session, entry: TranscriptEntry): void {
		if (entry.operation === 'enqueue') {
			session.queued = Math.min(9, session.queued + 1);
		} else if (entry.operation === 'dequeue' || entry.operation === 'remove') {
			session.queued = Math.max(0, session.queued - 1);
		}
	}

	/** Claude Code backs a file up just before its first edit in a turn: that backup is the "before". */
	private handleFileBackup(session: Session, entry: TranscriptEntry): void {
		const turn = session.turn;
		if (!turn || turn.status !== 'running' || !entry.trackingPath) {
			return;
		}
		const target = path.isAbsolute(entry.trackingPath)
			? entry.trackingPath
			: path.join(entry.backup?.realParentDir ?? session.cwd ?? '', path.basename(entry.trackingPath));
		const change = fileChange(turn, target);
		if (change.before) {
			return;
		}
		const name = entry.backup?.backupFileName;
		if (!name) {
			change.before = { created: true };
		} else if (this.claudeHome) {
			change.before = { backup: path.join(this.claudeHome(), 'file-history', session.sessionId, name) };
		}
	}

	// ------------------------------------------------------------------ lifecycle

	private openWait(session: Session, turn: Turn, wait: Wait): void {
		if (turn.wait) {
			this.closeWait(turn, wait.since);
		}
		turn.wait = wait;
		turn.waitCount += 1;
		this.waiting.fire({ ...this.event(session, turn), wait });
		this.updated.fire(this.event(session, turn));
	}

	private closeWait(turn: Turn, at: number): void {
		if (!turn.wait) {
			return;
		}
		turn.waitedMs += Math.max(0, at - turn.wait.since);
		turn.wait = undefined;
	}

	/**
	 * Whether background agents launched by this turn still keep it open: one is working, or one has
	 * finished but its report has not reached the session yet — Claude resumes when it does, so the
	 * prompt is not done. A report that never arrives stops counting after a grace period.
	 */
	private heldOpen(session: Session, turn: Turn, at: number): boolean {
		return holdingAgents(session, turn, at, this.staleMinutes()).length > 0;
	}

	private resumeIfBackground(turn: Turn): void {
		if (turn.phase === 'background') {
			turn.phase = 'working';
		}
	}

	private touch(session: Session, at: number): void {
		const turn = session.turn;
		if (turn?.status === 'running') {
			turn.lastActivityAt = Math.max(turn.lastActivityAt, at);
		}
	}

	/** Ends quiet turns and agents: gone silent for too long means abandoned, not still working. */
	sweep(now = Date.now()): void {
		const cutoff = now - this.staleMinutes() * 60_000;
		for (const session of this.sessions.values()) {
			for (const agent of Object.values(session.agents)) {
				if (agent.status === 'running' && agent.lastActivityAt < cutoff) {
					agent.status = 'done';
					agent.endedAt = agent.lastActivityAt;
				}
			}
			if (session.pendingAutomatic && now - session.pendingAutomatic.at > 10 * 60_000) {
				session.pendingAutomatic = undefined; // never answered
			}
			const turn = session.turn;
			if (!turn) {
				// Prompts only queue while Claude is busy, so an idle session has none waiting.
				session.queued = 0;
				continue;
			}
			if (turn.status !== 'running' || turn.wait) {
				// Waiting on the user is not going stale, however long the user takes.
				continue;
			}
			if (turn.phase === 'background') {
				if (!this.heldOpen(session, turn, now)) {
					this.finish(session, turn.lastReplyEndedAt ?? turn.lastActivityAt, 'done', 'reply');
				}
				continue;
			}
			if (turn.lastActivityAt < cutoff) {
				this.finish(session, turn.lastActivityAt, 'abandoned', 'stale');
			}
		}
	}

	private finish(session: Session, at: number, status: TurnStatus, endedBy: Turn['endedBy']): void {
		const turn = session.turn;
		if (!turn || turn.status !== 'running') {
			return;
		}
		turn.status = status;
		turn.endedAt = Math.max(at, turn.startedAt);
		turn.endedBy = endedBy;
		this.closeWait(turn, turn.endedAt);
		turn.retry = undefined;
		turn.pending = {};
		session.lastTurn = turn;
		session.turn = undefined;
		this.ended.fire(this.event(session, turn));
	}

	private event(session: Session, turn: Turn): TurnEvent {
		return { session, turn, replay: this.replaying };
	}

	isInScope(session: Session): boolean {
		return this.inScope(session.cwd);
	}

	dispose(): void {
		this.started.dispose();
		this.updated.dispose();
		this.ended.dispose();
		this.waiting.dispose();
	}
}

interface AgentMeta {
	agentType?: string;
	description?: string;
	toolUseId?: string;
	requestShape?: string;
}

export function runningAgents(session: Session): AgentInfo[] {
	return Object.values(session.agents).filter((agent) => agent.status === 'running');
}

/** Background agents launched by the turn that it is still waiting on — working, or about to report back. */
export function holdingAgents(session: Session, turn: Turn, at: number, staleMinutes = 30): AgentInfo[] {
	const staleBefore = at - staleMinutes * 60_000;
	return turn.agentIds
		.map((id) => session.agents[id])
		.filter((agent): agent is AgentInfo => {
			if (!agent?.background) {
				return false;
			}
			if (agent.status === 'running') {
				return agent.lastActivityAt >= staleBefore;
			}
			return !agent.handedBack && at - (agent.endedAt ?? 0) < HANDBACK_GRACE_MS;
		});
}

export function projectKey(cwd: string | undefined): string {
	return cwd ? path.resolve(cwd).toLowerCase() : 'unknown';
}

/** Time Claude has spent on the turn so far, excluding time spent blocked on the user. */
export function activeMs(turn: Turn, now = Date.now()): number {
	const end = turn.endedAt ?? now;
	const openWait = turn.wait && !turn.endedAt ? Math.max(0, now - turn.wait.since) : 0;
	return Math.max(0, end - turn.startedAt - turn.waitedMs - openWait);
}

function newTurn(session: Session, trigger: TurnTrigger, prompt: string, at: number, promptId?: string): Turn {
	return {
		sessionId: session.sessionId,
		project: projectKey(session.cwd),
		trigger,
		promptId,
		prompt,
		startedAt: at,
		status: 'running',
		phase: 'working',
		steps: [],
		toolCount: 0,
		errorCount: 0,
		outputTokens: 0,
		contextTokens: 0,
		lastActivityAt: at,
		waitedMs: 0,
		waitCount: 0,
		pending: {},
		files: {},
		agentIds: [],
		compactions: 0,
		countedMessages: []
	};
}

function fileChange(turn: Turn, filePath: string): FileChange {
	const key = normalizePath(filePath);
	let change = turn.files[key];
	if (!change) {
		change = { path: filePath, added: 0, removed: 0, edits: 0 };
		turn.files[key] = change;
	}
	return change;
}

function normalizePath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function findStep(turn: Turn, toolUseId: string): Step | undefined {
	for (let i = turn.steps.length - 1; i >= 0; i--) {
		if (turn.steps[i].toolUseId === toolUseId) {
			return turn.steps[i];
		}
	}
	return undefined;
}

export function isSubagentTranscript(file: string): boolean {
	return /[\\/]subagents[\\/][^\\/]+\.jsonl$/i.test(file);
}

/** `<project>/<session>/subagents/agent-x.jsonl` belongs to `<project>/<session>.jsonl`. */
function mainTranscriptFor(file: string, sessionId: string): string {
	return path.join(path.dirname(path.dirname(path.dirname(file))), `${sessionId}.jsonl`);
}

function sessionIdFromFile(file: string): string | undefined {
	if (isSubagentTranscript(file)) {
		return path.basename(path.dirname(path.dirname(file)));
	}
	const base = path.basename(file);
	return base.toLowerCase().endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : undefined;
}

function toMillis(timestamp: string | undefined): number {
	const parsed = timestamp ? Date.parse(timestamp) : NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function textOf(entry: TranscriptEntry): string {
	const content = entry.message?.content;
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter((b) => b.type === 'text' && b.text)
			.map((b) => b.text!)
			.join(' ');
	}
	return '';
}

function promptText(entry: TranscriptEntry): string {
	const content = entry.message?.content;
	if (typeof content === 'string') {
		return clean(content) || '(prompt)';
	}
	if (Array.isArray(content)) {
		const text = content
			.filter((b) => b.type === 'text' && b.text)
			.map((b) => b.text!)
			.join(' ');
		if (clean(text)) {
			return clean(text);
		}
		if (content.some((b) => b.type === 'image')) {
			return '(image prompt)';
		}
	}
	return '(prompt)';
}

function parseHandBack(text: string): string | undefined {
	const match = /<agent-message from="([^"]+)">/.exec(text);
	return match ? match[1] : undefined;
}

function parseTaskNotification(text: string): { id?: string; status?: string; summary?: string } | undefined {
	if (!text.includes('<task-notification>')) {
		return undefined;
	}
	const pick = (tag: string) => {
		const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
		return match ? clean(match[1]) : undefined;
	};
	return { id: pick('task-id'), status: pick('status'), summary: pick('summary') };
}

function firstQuestion(input: Record<string, unknown>): string | undefined {
	const questions = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
	const first = questions[0];
	const text = first && typeof first.question === 'string' ? first.question : undefined;
	if (!text) {
		return undefined;
	}
	const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : '';
	return `${clean(text).slice(0, 200)}${more}`;
}

export function clean(text: string): string {
	return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeBlock(block: ContentBlock, at: number, prefix: string): Step | undefined {
	if (block.type === 'tool_use') {
		return { label: prefix + (block.name || 'tool'), at, detail: toolDetail(block), toolUseId: block.id };
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
	for (const key of ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'description', 'prompt', 'url', 'query']) {
		const value = input[key];
		if (typeof value === 'string' && value.trim()) {
			return value.replace(/\s+/g, ' ').slice(0, 120);
		}
	}
	return undefined;
}

export type { TodoItem };
