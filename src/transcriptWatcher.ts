import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TranscriptEntry } from './types';

const MAX_CHUNK = 4 * 1024 * 1024;
const REPLAY_BYTES = 2 * 1024 * 1024;

export interface EntryEvent {
	file: string;
	entry: TranscriptEntry;
	/** Read from history at startup rather than written just now. */
	replay?: boolean;
}

export interface WatcherOptions {
	/** Extra directories to watch — the `subagents` folders of sessions that are busy right now. */
	extraDirs?: () => string[];
	/** Transcripts written within this window are replayed at startup, so a running prompt is picked up. */
	replayWindowMs?: number;
}

export function claudeHome(): string {
	const configured = vscode.workspace.getConfiguration('claudePromptMonitor').get<string>('claudeHome');
	if (configured && configured.trim()) {
		return configured.trim();
	}
	if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()) {
		return process.env.CLAUDE_CONFIG_DIR.trim();
	}
	return path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
	return path.join(claudeHome(), 'projects');
}

/**
 * Tails every `*.jsonl` transcript under `~/.claude/projects`, which is where both the
 * Claude Code VS Code extension and the terminal CLI record their sessions, plus the
 * `<session>/subagents/*.jsonl` transcripts of agents working for a busy session.
 */
export class TranscriptWatcher implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<EntryEvent>();
	readonly onEntry = this.emitter.event;

	private offsets = new Map<string, number>();
	private timer?: NodeJS.Timeout;
	private watcher?: fs.FSWatcher;
	private pollQueued = false;

	constructor(private readonly options: WatcherOptions = {}) {}

	/**
	 * Seeds offsets at end-of-file so existing transcript content is never treated as new work — except
	 * the recent tail of transcripts written in the last few minutes, which is replayed (flagged as
	 * such) so a prompt that was already running when the window reloaded is tracked, not missed.
	 */
	start(): void {
		const window = this.options.replayWindowMs ?? 0;
		const now = Date.now();
		for (const file of this.listTranscripts()) {
			let stat: fs.Stats;
			try {
				stat = fs.statSync(file);
			} catch {
				continue; // file vanished between listing and stat
			}
			if (window > 0 && now - stat.mtimeMs < window) {
				this.replayTail(file, stat.size);
			}
			this.offsets.set(file, stat.size);
		}
		this.schedulePoll();
		this.attachWatcher();
	}

	private replayTail(file: string, size: number): void {
		const start = Math.max(0, size - REPLAY_BYTES);
		const buf = this.read(file, start, size - start);
		if (!buf) {
			return;
		}
		const lines = buf.toString('utf8').split('\n');
		if (start > 0) {
			lines.shift(); // a mid-file start lands inside a line
		}
		const complete = buf[buf.length - 1] === 0x0a ? lines : lines.slice(0, -1);
		for (const line of complete) {
			const entry = parseLine(line);
			if (entry) {
				this.emitter.fire({ file, entry, replay: true });
			}
		}
	}

	private schedulePoll(): void {
		const ms = vscode.workspace.getConfiguration('claudePromptMonitor').get<number>('pollIntervalMs') ?? 800;
		this.timer = setInterval(() => this.poll(), Math.max(200, ms));
	}

	private attachWatcher(): void {
		const dir = projectsDir();
		if (!fs.existsSync(dir)) {
			return;
		}
		try {
			// A recursive watch makes the common case feel instant; the poll is the safety net.
			this.watcher = fs.watch(dir, { recursive: true }, () => {
				if (this.pollQueued) {
					return;
				}
				this.pollQueued = true;
				setTimeout(() => {
					this.pollQueued = false;
					this.poll();
				}, 60);
			});
		} catch {
			/* recursive watching is unsupported on some platforms; polling still covers us */
		}
	}

	listTranscripts(): string[] {
		const root = projectsDir();
		const out: string[] = [];
		let projects: string[];
		try {
			projects = fs.readdirSync(root);
		} catch {
			return out;
		}
		for (const project of projects) {
			const dir = path.join(root, project);
			let names: string[];
			try {
				if (!fs.statSync(dir).isDirectory()) {
					continue;
				}
				names = fs.readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (name.endsWith('.jsonl')) {
					out.push(path.join(dir, name));
				}
			}
		}
		return out;
	}

	private listAgentTranscripts(): string[] {
		const out: string[] = [];
		for (const dir of this.options.extraDirs?.() ?? []) {
			let names: string[];
			try {
				names = fs.readdirSync(dir);
			} catch {
				continue; // most sessions never start an agent
			}
			for (const name of names) {
				if (name.endsWith('.jsonl')) {
					out.push(path.join(dir, name));
				}
			}
		}
		return out;
	}

	poll(): void {
		for (const file of this.listTranscripts()) {
			this.drain(file, 0);
		}
		// An agent transcript from long ago says nothing about now; only recent ones are read in full.
		const window = this.options.replayWindowMs ?? 30 * 60_000;
		for (const file of this.listAgentTranscripts()) {
			this.drain(file, window);
		}
	}

	/**
	 * Reads whole lines appended since the last read and emits them. A file seen for the first time is
	 * read from the top — it is a brand new session — unless `freshWindowMs` says it is too old to matter.
	 */
	private drain(file: string, freshWindowMs: number): void {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			return;
		}
		const size = stat.size;
		let offset = this.offsets.get(file);
		if (offset === undefined) {
			offset = freshWindowMs > 0 && Date.now() - stat.mtimeMs > freshWindowMs ? size : 0;
		}
		if (size < offset) {
			offset = 0; // truncated or rotated
		}
		if (size === offset) {
			this.offsets.set(file, offset);
			return;
		}
		const buf = this.read(file, offset, Math.min(size - offset, MAX_CHUNK));
		if (!buf) {
			return;
		}
		const lastNewline = buf.lastIndexOf(0x0a);
		if (lastNewline < 0) {
			return; // a line is still being written
		}
		this.offsets.set(file, offset + lastNewline + 1);
		for (const line of buf.subarray(0, lastNewline).toString('utf8').split('\n')) {
			const entry = parseLine(line);
			if (entry) {
				this.emitter.fire({ file, entry });
			}
		}
	}

	private read(file: string, offset: number, length: number): Buffer | undefined {
		let fd: number | undefined;
		try {
			fd = fs.openSync(file, 'r');
			const buf = Buffer.allocUnsafe(length);
			const read = fs.readSync(fd, buf, 0, length, offset);
			return buf.subarray(0, read);
		} catch {
			return undefined;
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch {
					/* ignore */
				}
			}
		}
	}

	/**
	 * Reads the tail of every recent transcript without emitting events — used once at startup to
	 * learn how long past prompts took, so the first estimate is not a guess.
	 */
	backfill(maxFiles: number, maxBytesPerFile: number, sink: (event: EntryEvent) => void): void {
		const files = this.listTranscripts()
			.map((file) => {
				try {
					const stat = fs.statSync(file);
					return { file, mtime: stat.mtimeMs, size: stat.size };
				} catch {
					return undefined;
				}
			})
			.filter((f): f is { file: string; mtime: number; size: number } => !!f)
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, maxFiles);

		for (const { file, size } of files) {
			const start = Math.max(0, size - maxBytesPerFile);
			const buf = this.read(file, start, size - start);
			if (!buf) {
				continue;
			}
			const text = buf.toString('utf8');
			// A non-zero start almost certainly lands mid-line; drop that fragment.
			const lines = text.split('\n');
			if (start > 0) {
				lines.shift();
			}
			for (const line of lines) {
				const entry = parseLine(line);
				if (entry) {
					sink({ file, entry });
				}
			}
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
		this.watcher?.close();
		this.emitter.dispose();
	}
}

function parseLine(line: string): TranscriptEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed) as TranscriptEntry;
	} catch {
		return undefined;
	}
}
