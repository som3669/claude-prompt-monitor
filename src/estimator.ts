import { activeMs } from './turnTracker';
import { HistoryRecord, Turn } from './types';

const STORAGE_KEY = 'claudePromptMonitor.history.v1';
const MIN_SAMPLES = 3;

export interface Storage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export interface Estimate {
	/** Predicted time Claude will spend on the turn, excluding time spent waiting on the user. */
	totalMs: number;
	/** Predicted time left, never negative. */
	remainingMs: number;
	/** Wall-clock total: time since the prompt was sent plus the time left. What the clock should show. */
	wallTotalMs: number;
	/** 0..1, clamped so a running turn never shows as complete. */
	progress: number;
	/** False when there was too little history and the number is a rough fallback. */
	confident: boolean;
}

/**
 * Predicts how long a prompt will take from how long past prompts in the same project took.
 *
 * While a turn runs the estimate is re-conditioned on what has happened so far: elapsed time rules
 * out the quick outcomes, and the tool count rules out the samples that finished with less work.
 * Time spent blocked on the user — answering a question, approving a plan — is not Claude's time,
 * so it is left out of both the history and the running clock.
 */
export class Estimator {
	private history: HistoryRecord[] = [];
	private keys = new Set<string>();

	constructor(private readonly storage: Storage, private readonly limitPerProject: () => number) {
		this.history = storage.get<HistoryRecord[]>(STORAGE_KEY) ?? [];
		this.reindex();
	}

	get size(): number {
		return this.history.length;
	}

	/** The raw records, so they can be published to a file the desktop widget can read. */
	export(): HistoryRecord[] {
		return this.history;
	}

	record(turn: Turn): void {
		// Only prompts a person sent: a background hand-back says nothing about how long a prompt takes.
		if (turn.status !== 'done' || !turn.endedAt || turn.trigger !== 'human') {
			return;
		}
		if (this.add(toRecord(turn))) {
			this.prune();
			void this.storage.update(STORAGE_KEY, this.history);
		}
	}

	/**
	 * Adds a record discovered by replaying old transcripts, without re-saving on every row. The same
	 * transcripts are replayed on every start, so a record already held is skipped.
	 */
	seed(record: HistoryRecord): void {
		this.add(record);
	}

	flushSeed(): void {
		this.prune();
		void this.storage.update(STORAGE_KEY, this.history);
	}

	clear(): void {
		this.history = [];
		this.keys.clear();
		void this.storage.update(STORAGE_KEY, this.history);
	}

	stats(project: string | undefined): { count: number; p50: number; p90: number } | undefined {
		const samples = this.samplesFor(project).map((r) => r.durationMs).sort((a, b) => a - b);
		if (!samples.length) {
			return undefined;
		}
		return { count: samples.length, p50: quantile(samples, 0.5), p90: quantile(samples, 0.9) };
	}

	/** The up-front guess, made the moment a prompt is submitted. */
	initial(turn: Turn): number | undefined {
		const samples = this.matching(turn.project, turn.prompt.length, 0);
		if (samples.length < MIN_SAMPLES) {
			return undefined;
		}
		return quantile(samples.sort((a, b) => a - b), 0.5);
	}

	/** The live estimate, refined from elapsed time and the work done so far. */
	current(turn: Turn, now: number): Estimate {
		const elapsed = activeMs(turn, now);
		const wallElapsed = Math.max(0, now - turn.startedAt);
		const samples = this.matching(turn.project, turn.prompt.length, turn.toolCount).sort((a, b) => a - b);
		const build = (total: number, cap: number, confident: boolean): Estimate => {
			const remainingMs = Math.max(0, total - elapsed);
			return {
				totalMs: total,
				remainingMs,
				wallTotalMs: wallElapsed + remainingMs,
				progress: clamp(elapsed / total, 0, cap),
				confident
			};
		};

		if (samples.length < MIN_SAMPLES) {
			return build(Math.max(turn.initialEstimateMs ?? 0, elapsed * 1.5, 30_000), 0.95, false);
		}

		// Walk up the quantiles until one is still ahead of where we already are.
		let total = 0;
		for (const q of [0.5, 0.75, 0.9, 0.98]) {
			total = quantile(samples, q);
			if (total > elapsed * 1.05) {
				break;
			}
		}
		if (total <= elapsed * 1.05) {
			return build(elapsed * 1.25, 0.9, false); // past everything we have on record
		}
		return build(total, 0.95, true);
	}

	private add(record: HistoryRecord): boolean {
		if (record.durationMs < 1000) {
			return false; // instant replies say nothing useful about the next prompt
		}
		const key = recordKey(record);
		if (this.keys.has(key)) {
			return false;
		}
		this.keys.add(key);
		this.history.push(record);
		return true;
	}

	private reindex(): void {
		// Older builds re-seeded the same transcripts on every start; drop the duplicates they left.
		const seen = new Set<string>();
		this.history = this.history.filter((record) => {
			const key = recordKey(record);
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
		this.keys = seen;
	}

	private samplesFor(project: string | undefined): HistoryRecord[] {
		if (!project) {
			return this.history;
		}
		const scoped = this.history.filter((r) => r.project === project);
		return scoped.length >= MIN_SAMPLES ? scoped : this.history;
	}

	private matching(project: string, promptChars: number, minToolCount: number): number[] {
		const scoped = this.samplesFor(project);
		const byWork = scoped.filter((r) => r.toolCount >= minToolCount);
		const pool = byWork.length >= MIN_SAMPLES ? byWork : scoped;

		// Prefer prompts of a comparable size, but only when that leaves enough to work with.
		const similar = pool.filter((r) => {
			const ratio = (r.promptChars + 40) / (promptChars + 40);
			return ratio >= 0.25 && ratio <= 4;
		});
		const chosen = similar.length >= 5 ? similar : pool;
		return chosen.map((r) => r.durationMs);
	}

	private prune(): void {
		const limit = Math.max(20, this.limitPerProject());
		const byProject = new Map<string, HistoryRecord[]>();
		for (const record of this.history) {
			const list = byProject.get(record.project) ?? [];
			list.push(record);
			byProject.set(record.project, list);
		}
		const kept: HistoryRecord[] = [];
		for (const list of byProject.values()) {
			list.sort((a, b) => a.finishedAt - b.finishedAt);
			kept.push(...list.slice(-limit));
		}
		this.history = kept.sort((a, b) => a.finishedAt - b.finishedAt);
		this.keys = new Set(this.history.map(recordKey));
	}
}

export function toRecord(turn: Turn): HistoryRecord {
	return {
		project: turn.project,
		durationMs: activeMs(turn),
		toolCount: turn.toolCount,
		promptChars: turn.prompt.length,
		finishedAt: turn.endedAt ?? turn.startedAt
	};
}

function recordKey(record: HistoryRecord): string {
	return `${record.project}|${record.finishedAt}`;
}

function quantile(sorted: number[], q: number): number {
	if (!sorted.length) {
		return 0;
	}
	const pos = (sorted.length - 1) * q;
	const lower = Math.floor(pos);
	const upper = Math.ceil(pos);
	if (lower === upper) {
		return sorted[lower];
	}
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
