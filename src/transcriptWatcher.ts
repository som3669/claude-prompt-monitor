import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TranscriptEntry } from './types';

const MAX_CHUNK = 4 * 1024 * 1024;

export interface EntryEvent {
	file: string;
	entry: TranscriptEntry;
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
 * Claude Code VS Code extension and the terminal CLI record their sessions.
 */
export class TranscriptWatcher implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<EntryEvent>();
	readonly onEntry = this.emitter.event;

	private offsets = new Map<string, number>();
	private timer?: NodeJS.Timeout;
	private watcher?: fs.FSWatcher;
	private pollQueued = false;

	/** Seeds offsets at end-of-file so existing transcript content is never replayed as new work. */
	start(): void {
		for (const file of this.listTranscripts()) {
			try {
				this.offsets.set(file, fs.statSync(file).size);
			} catch {
				/* file vanished between listing and stat */
			}
		}
		this.schedulePoll();
		this.attachWatcher();
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

	poll(): void {
		for (const file of this.listTranscripts()) {
			this.drain(file);
		}
	}

	/** Reads whole lines appended since the last read and emits them. */
	private drain(file: string): void {
		let size: number;
		try {
			size = fs.statSync(file).size;
		} catch {
			return;
		}
		let offset = this.offsets.get(file);
		if (offset === undefined) {
			// A transcript that appeared after startup — a brand new session, so read it from the top.
			offset = 0;
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
