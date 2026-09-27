import * as vscode from 'vscode';
import { Storage } from './estimator';
import { TurnSummary } from './types';

const STORAGE_KEY = 'claudePromptMonitor.recent.v1';
const LIMIT = 100;

/** Finished turns, newest first, for the dashboard's Recent list and Today numbers. */
export class RecentStore implements vscode.Disposable {
	private items: TurnSummary[];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(private readonly storage: Storage) {
		this.items = storage.get<TurnSummary[]>(STORAGE_KEY) ?? [];
	}

	all(): TurnSummary[] {
		return this.items;
	}

	get(key: string): TurnSummary | undefined {
		return this.items.find((item) => item.key === key);
	}

	has(key: string): boolean {
		return this.items.some((item) => item.key === key);
	}

	/** Adds or replaces a turn. `quiet` batches a replay: the caller calls `flush()` once at the end. */
	add(summary: TurnSummary, quiet = false): void {
		this.items = [summary, ...this.items.filter((item) => item.key !== summary.key)]
			.sort((a, b) => b.endedAt - a.endedAt)
			.slice(0, LIMIT);
		if (!quiet) {
			this.flush();
		}
	}

	flush(): void {
		void this.storage.update(STORAGE_KEY, this.items);
		this.changed.fire();
	}

	/** Turns that finished since local midnight. */
	today(now = Date.now()): TurnSummary[] {
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		return this.items.filter((item) => item.endedAt >= midnight.getTime());
	}

	clear(): void {
		this.items = [];
		this.flush();
	}

	dispose(): void {
		this.changed.dispose();
	}
}
