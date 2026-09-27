/** Shapes we care about inside a Claude Code transcript (`~/.claude/projects/<slug>/<session>.jsonl`). */

export interface TranscriptEntry {
	type?: string;
	subtype?: string;
	uuid?: string;
	timestamp?: string;
	sessionId?: string;
	agentId?: string;
	cwd?: string;
	gitBranch?: string;
	entrypoint?: string;
	version?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isApiErrorMessage?: boolean;
	error?: unknown;
	quotaLimits?: { status?: string; resetsAt?: number; rateLimitType?: string };
	promptId?: string;
	origin?: { kind?: string };
	toolUseResult?: unknown;
	message?: {
		id?: string;
		role?: string;
		model?: string;
		stop_reason?: string | null;
		content?: string | ContentBlock[];
		usage?: Usage;
	};
	/** `system` entries. */
	content?: unknown;
	retryInMs?: number;
	retryAttempt?: number;
	maxRetries?: number;
	compactMetadata?: { trigger?: string; preTokens?: number };
	/** `ai-title` / `custom-title` entries. */
	aiTitle?: string;
	customTitle?: string;
	/** `queue-operation` entries. */
	operation?: string;
	/** `permission-mode` entries. */
	permissionMode?: string;
	/** `cost-state` entries. */
	totalCostUSD?: number;
	/** `file-history-delta` entries: Claude Code's own backup of a file, taken before it is edited. */
	trackingPath?: string;
	backup?: { backupFileName?: string | null; realParentDir?: string };
}

export interface ContentBlock {
	type: string;
	id?: string;
	text?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	is_error?: boolean;
	content?: unknown;
}

export interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export interface Step {
	/** Tool name, or a pseudo-step such as `thinking`. */
	label: string;
	at: number;
	detail?: string;
	/** Set when the tool call came back as an error. */
	failed?: boolean;
	/** Tool-use id, so the result can be matched back to the step. */
	toolUseId?: string;
}

export type TurnStatus = 'running' | 'done' | 'error' | 'interrupted' | 'limited' | 'abandoned';

/** What started the turn: a person, a background task finishing, or another session (an agent hand-back). */
export type TurnTrigger = 'human' | 'background' | 'peer';

/**
 * `working` while Claude is generating or running tools. `background` once the main reply has ended
 * but agents it launched in the background are still going — Claude picks the turn back up when they
 * hand back, so the prompt is not finished yet.
 */
export type TurnPhase = 'working' | 'background';

export type WaitKind = 'question' | 'plan' | 'permission' | 'input';

/** Claude is blocked until the user does something. */
export interface Wait {
	kind: WaitKind;
	since: number;
	detail?: string;
	toolUseId?: string;
	/** `hook` when it came from the optional Notification hook rather than the transcript. */
	source: 'transcript' | 'hook';
}

/** The API call failed and Claude Code is retrying it. */
export interface Retry {
	message: string;
	attempt: number;
	max: number;
	at: number;
	retryAt: number;
}

export interface TodoItem {
	content: string;
	status: string;
	activeForm?: string;
}

/** Where the pre-edit content of a changed file can be found. */
export interface FileBefore {
	/** Claude Code's own file-history backup, taken just before the first edit in this turn. */
	backup?: string;
	/** The file did not exist before this turn. */
	created?: boolean;
}

export interface FileChange {
	path: string;
	added: number;
	removed: number;
	edits: number;
	before?: FileBefore;
}

export interface AgentInfo {
	id: string;
	toolUseId?: string;
	description: string;
	type?: string;
	/** Launched with `run_in_background` — the turn does not wait for it. */
	background: boolean;
	status: 'running' | 'done' | 'failed';
	startedAt: number;
	endedAt?: number;
	lastActivityAt: number;
	tools: number;
	lastStep?: string;
	/** Its report has reached the parent session, which then picks the work back up. */
	handedBack?: boolean;
}

export interface Turn {
	sessionId: string;
	/** Project the turn is attributed to, pinned at prompt time so a mid-turn `cd` cannot split it. */
	project: string;
	trigger: TurnTrigger;
	promptId?: string;
	prompt: string;
	startedAt: number;
	endedAt?: number;
	status: TurnStatus;
	phase: TurnPhase;
	steps: Step[];
	toolCount: number;
	errorCount: number;
	outputTokens: number;
	/** Size of the context on the latest request: input + cache writes + cache reads. */
	contextTokens: number;
	model?: string;
	/** Last time the transcript produced anything for this turn. */
	lastActivityAt: number;
	/** When the main reply last ended, while background agents kept the turn open. */
	lastReplyEndedAt?: number;
	/** Milliseconds predicted at the time the turn started. */
	initialEstimateMs?: number;
	/** Set while Claude is blocked on the user. */
	wait?: Wait;
	/** Time already spent blocked on the user, excluding the open wait. */
	waitedMs: number;
	waitCount: number;
	retry?: Retry;
	/** Tool calls that have not returned yet, by tool-use id. */
	pending: Record<string, { name: string; at: number }>;
	files: Record<string, FileChange>;
	/** Agents launched in this turn, by agent id (or tool-use id until the launch is confirmed). */
	agentIds: string[];
	/** The last text Claude wrote in the turn — usually the answer or the summary. */
	finalText?: string;
	errorMessage?: string;
	limitResetsAt?: number;
	compactions: number;
	/** Why the turn ended, when that matters for notifying: a new prompt means the user is already back. */
	endedBy?: 'reply' | 'next-prompt' | 'interrupt' | 'stale' | 'error';
	/** Message ids already counted, since Claude Code writes one entry per content block with the same usage. */
	countedMessages: string[];
}

export interface Session {
	sessionId: string;
	file: string;
	cwd?: string;
	gitBranch?: string;
	entrypoint?: string;
	/** The title Claude Code generated for the conversation. */
	title?: string;
	/** A title the user set with /rename; wins over the generated one. */
	customTitle?: string;
	turn?: Turn;
	lastTurn?: Turn;
	lastSeenAt: number;
	agents: Record<string, AgentInfo>;
	todos?: TodoItem[];
	/** When the task list was last written, so a list left over from an earlier turn can be told apart. */
	todosAt?: number;
	/** Prompts typed while Claude was busy, waiting their turn. */
	queued: number;
	permissionMode?: string;
	costUSD?: number;
	limitResetsAt?: number;
	/** A background notification Claude has not answered yet; it becomes a turn when Claude replies. */
	pendingAutomatic?: { trigger: TurnTrigger; label: string; at: number; promptId?: string };
}

/** One completed turn, kept for estimating how long the next one will take. */
export interface HistoryRecord {
	project: string;
	/** Time Claude spent on it, excluding time spent waiting on the user. */
	durationMs: number;
	toolCount: number;
	promptChars: number;
	finishedAt: number;
}

/** A finished turn as the dashboard and the Recent list remember it. */
export interface TurnSummary {
	key: string;
	sessionId: string;
	project: string;
	title?: string;
	prompt: string;
	trigger: TurnTrigger;
	status: TurnStatus;
	startedAt: number;
	endedAt: number;
	activeMs: number;
	waitedMs: number;
	tools: number;
	errors: number;
	outputTokens: number;
	model?: string;
	files: FileChange[];
	agents: number;
	tasksDone?: number;
	tasksTotal?: number;
	finalText?: string;
	errorMessage?: string;
	limitResetsAt?: number;
	transcript: string;
}
