import { HistoryRecord, Turn } from './types';

const STORAGE_KEY = 'claudePromptMonitor.history.v1';
const MIN_SAMPLES = 3;

export interface Storage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export interface Estimate {
	/** Predicted total duration of the turn, in milliseconds. */
	totalMs: number;
	/** Predicted time left, never negative. */
	remainingMs: number;
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
 */
export class Estimator {
	private history: HistoryRecord[] = [];

	constructor(private readonly storage: Storage, private readonly limitPerProject: () => number) {
		this.history = storage.get<HistoryRecord[]>(STORAGE_KEY) ?? [];
	}

	get size(): number {
		return this.history.length;
	}

	/** The raw records, so they can be published to a file the desktop widget can read. */
	export(): HistoryRecord[] {
		return this.history;
	}

	record(turn: Turn): void {
		if (turn.status !== 'done' || !turn.endedAt) {
			return;
		}
		const durationMs = turn.endedAt - turn.startedAt;
		if (durationMs < 1000) {
			return; // instant replies say nothing useful about the next prompt
		}
		this.history.push({
			project: turn.project,
			durationMs,
			toolCount: turn.toolCount,
			promptChars: turn.prompt.length,
			finishedAt: turn.endedAt
		});
		this.prune();
		void this.storage.update(STORAGE_KEY, this.history);
	}

	/** Adds a record discovered by replaying old transcripts, without re-saving on every row. */
	seed(record: HistoryRecord): void {
		if (record.durationMs < 1000) {
			return;
		}
		this.history.push(record);
	}

	flushSeed(): void {
		this.prune();
		void this.storage.update(STORAGE_KEY, this.history);
	}

	clear(): void {
		this.history = [];
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
		const elapsed = Math.max(0, now - turn.startedAt);
		const samples = this.matching(turn.project, turn.prompt.length, turn.toolCount).sort((a, b) => a - b);

		if (samples.length < MIN_SAMPLES) {
			const fallback = Math.max(turn.initialEstimateMs ?? 0, elapsed * 1.5, 30_000);
			return {
				totalMs: fallback,
				remainingMs: Math.max(0, fallback - elapsed),
				progress: clamp(elapsed / fallback, 0, 0.95),
				confident: false
			};
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
			total = elapsed * 1.25; // past everything we have on record
			return {
				totalMs: total,
				remainingMs: Math.max(0, total - elapsed),
				progress: clamp(elapsed / total, 0, 0.9),
				confident: false
			};
		}
		return {
			totalMs: total,
			remainingMs: Math.max(0, total - elapsed),
			progress: clamp(elapsed / total, 0, 0.95),
			confident: true
		};
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
	}
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
