/** Shapes we care about inside a Claude Code transcript (`~/.claude/projects/<slug>/<session>.jsonl`). */

export interface TranscriptEntry {
	type?: string;
	uuid?: string;
	timestamp?: string;
	sessionId?: string;
	cwd?: string;
	gitBranch?: string;
	entrypoint?: string;
	version?: string;
	isSidechain?: boolean;
	isApiErrorMessage?: boolean;
	promptId?: string;
	origin?: { kind?: string };
	message?: {
		role?: string;
		model?: string;
		stop_reason?: string | null;
		content?: string | ContentBlock[];
		usage?: Usage;
	};
}

export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
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
}

export type TurnStatus = 'running' | 'done' | 'error' | 'abandoned';

export interface Turn {
	sessionId: string;
	/** Project the turn is attributed to, pinned at prompt time so a mid-turn `cd` cannot split it. */
	project: string;
	promptId?: string;
	prompt: string;
	startedAt: number;
	endedAt?: number;
	status: TurnStatus;
	steps: Step[];
	toolCount: number;
	outputTokens: number;
	model?: string;
	/** Last time the transcript produced anything for this turn. */
	lastActivityAt: number;
	/** Milliseconds predicted at the time the turn started. */
	initialEstimateMs?: number;
}

export interface Session {
	sessionId: string;
	file: string;
	cwd?: string;
	gitBranch?: string;
	entrypoint?: string;
	turn?: Turn;
	lastTurn?: Turn;
	lastSeenAt: number;
}

/** One completed turn, kept for estimating how long the next one will take. */
export interface HistoryRecord {
	project: string;
	durationMs: number;
	toolCount: number;
	promptChars: number;
	finishedAt: number;
}
