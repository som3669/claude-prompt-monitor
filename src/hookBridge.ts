import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeHome } from './transcriptWatcher';
import { TurnTracker } from './turnTracker';
import { WaitKind } from './types';

/** Every hook entry this extension adds carries this in its command, so it can find and remove its own. */
const MARKER = 'claude-prompt-monitor-hook';
/** Consumed events are dropped once the file grows past this. */
const ROTATE_BYTES = 256 * 1024;

interface HookEntry {
	type?: string;
	command?: string;
}

interface HookGroup {
	matcher?: string;
	hooks?: HookEntry[];
}

/**
 * The optional, opt-in Claude Code Notification hook.
 *
 * A permission prompt leaves no trace in the transcript until it is answered, so the transcript alone
 * cannot say "Claude is waiting for your approval". Claude Code's Notification hook can: installed,
 * it appends one JSON line per notification to an events file, and this class tails that file.
 */
export class HookBridge implements vscode.Disposable {
	private offset = 0;
	private timer?: NodeJS.Timeout;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(
		private readonly tracker: TurnTracker,
		private readonly extensionPath: string,
		private readonly eventsFile: string,
		private readonly output: vscode.OutputChannel
	) {}

	start(): void {
		try {
			this.offset = fs.statSync(this.eventsFile).size; // older events are about prompts long answered
		} catch {
			this.offset = 0;
		}
		this.timer = setInterval(() => this.poll(), 700);
	}

	private get settingsPath(): string {
		return path.join(claudeHome(), 'settings.json');
	}

	private get scriptTarget(): string {
		const name = process.platform === 'win32' ? `${MARKER}.ps1` : `${MARKER}.sh`;
		return path.join(claudeHome(), 'hooks', name);
	}

	private command(): string {
		if (process.platform === 'win32') {
			return `powershell -NoProfile -ExecutionPolicy Bypass -File "${this.scriptTarget}" -Out "${this.eventsFile}"`;
		}
		return `/bin/sh "${this.scriptTarget}" "${this.eventsFile}"`;
	}

	isInstalled(): boolean {
		const settings = this.readSettings();
		return !!settings && ourGroups(settings).length > 0;
	}

	async install(): Promise<void> {
		if (this.isInstalled()) {
			void vscode.window.showInformationMessage('The permission alert hook is already installed.');
			return;
		}
		const confirm = await vscode.window.showInformationMessage(
			'Install the permission alert hook?',
			{
				modal: true,
				detail:
					`This adds a Notification hook to ${this.settingsPath} (your other hooks are kept) and copies a small ` +
					`script to ${this.scriptTarget}. Claude Code then runs it whenever it shows a permission prompt, so the ` +
					'monitor can tell you the moment Claude is waiting for approval. The script only appends the event to a ' +
					'local file; nothing leaves this machine. A backup of settings.json is saved next to it first.'
			},
			'Install'
		);
		if (confirm !== 'Install') {
			return;
		}
		try {
			const settings = this.readSettings(true) ?? {};
			const source = path.join(
				this.extensionPath,
				'media',
				process.platform === 'win32' ? 'hook-notify.ps1' : 'hook-notify.sh'
			);
			fs.mkdirSync(path.dirname(this.scriptTarget), { recursive: true });
			fs.copyFileSync(source, this.scriptTarget);
			if (fs.existsSync(this.settingsPath)) {
				fs.copyFileSync(this.settingsPath, `${this.settingsPath}.before-claude-prompt-monitor`);
			}
			const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<
				string,
				HookGroup[]
			>;
			const groups = Array.isArray(hooks.Notification) ? hooks.Notification : [];
			groups.push({ matcher: '', hooks: [{ type: 'command', command: this.command() }] });
			hooks.Notification = groups;
			settings.hooks = hooks;
			this.writeSettings(settings);
			this.output.appendLine(`Installed the Notification hook in ${this.settingsPath}.`);
			this.changed.fire();
			void vscode.window.showInformationMessage(
				'Permission alert hook installed. It applies to Claude Code sessions started from now on.'
			);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not install the hook: ${String(error)}`);
		}
	}

	async uninstall(): Promise<void> {
		let settings: Record<string, unknown> | undefined;
		try {
			settings = this.readSettings(true);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not remove the hook: ${String(error)}`);
			return;
		}
		if (!settings || !ourGroups(settings).length) {
			void vscode.window.showInformationMessage('The permission alert hook is not installed.');
			return;
		}
		try {
			const hooks = settings.hooks as Record<string, HookGroup[]>;
			const kept = hooks.Notification.map((group) => ({
				...group,
				hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook))
			})).filter((group) => (group.hooks ?? []).length > 0);
			if (kept.length) {
				hooks.Notification = kept;
			} else {
				delete hooks.Notification;
			}
			if (!Object.keys(hooks).length) {
				delete settings.hooks;
			}
			this.writeSettings(settings);
			try {
				fs.unlinkSync(this.scriptTarget);
			} catch {
				/* already gone */
			}
			this.output.appendLine(`Removed the Notification hook from ${this.settingsPath}.`);
			this.changed.fire();
			void vscode.window.showInformationMessage('Permission alert hook removed.');
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not remove the hook: ${String(error)}`);
		}
	}

	private readSettings(strict = false): Record<string, unknown> | undefined {
		let text: string;
		try {
			text = fs.readFileSync(this.settingsPath, 'utf8');
		} catch {
			return strict ? {} : undefined;
		}
		try {
			return JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
		} catch (error) {
			if (strict) {
				// Never rewrite a settings file we could not read: that would lose whatever is in it.
				throw new Error(`${this.settingsPath} is not valid JSON (${String(error)}); leaving it untouched.`);
			}
			return undefined;
		}
	}

	private writeSettings(settings: Record<string, unknown>): void {
		const temporary = `${this.settingsPath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
		fs.renameSync(temporary, this.settingsPath);
	}

	private poll(): void {
		let size: number;
		try {
			size = fs.statSync(this.eventsFile).size;
		} catch {
			return;
		}
		if (size < this.offset) {
			this.offset = 0; // rotated
		}
		if (size === this.offset) {
			if (size > ROTATE_BYTES) {
				try {
					fs.truncateSync(this.eventsFile, 0);
					this.offset = 0;
				} catch {
					/* the hook may be writing right now; try again next time */
				}
			}
			return;
		}
		let text: string;
		try {
			const fd = fs.openSync(this.eventsFile, 'r');
			try {
				const buf = Buffer.alloc(size - this.offset);
				fs.readSync(fd, buf, 0, buf.length, this.offset);
				const lastNewline = buf.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					return;
				}
				text = buf.subarray(0, lastNewline).toString('utf8');
				this.offset += lastNewline + 1;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return;
		}
		for (const line of text.split('\n')) {
			this.handleLine(line.trim());
		}
	}

	private handleLine(line: string): void {
		if (!line.startsWith('{')) {
			return;
		}
		let record: { at?: number; event?: Record<string, unknown> };
		try {
			record = JSON.parse(line);
		} catch {
			return;
		}
		const event = record.event;
		if (!event || event.hook_event_name !== 'Notification') {
			return;
		}
		const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
		const type = typeof event.notification_type === 'string' ? event.notification_type : '';
		const message = typeof event.message === 'string' ? event.message : undefined;
		const kind = waitKindFor(type, message);
		this.output.appendLine(`[hook] ${type || 'notification'} ${sessionId.slice(0, 8)} ${message ?? ''}`);
		if (sessionId && kind) {
			this.tracker.hookWait(sessionId, kind, message, record.at ?? Date.now());
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
		this.changed.dispose();
	}
}

function waitKindFor(type: string, message: string | undefined): WaitKind | undefined {
	if (type === 'permission_prompt') {
		return 'permission';
	}
	if (type === 'elicitation_dialog' || type === 'agent_needs_input') {
		return 'input';
	}
	if (!type && message && /permission/i.test(message)) {
		return 'permission'; // older Claude Code without notification_type
	}
	return undefined; // idle_prompt and the rest: Claude is done, or it is not about waiting
}

function isOurs(hook: HookEntry): boolean {
	return typeof hook.command === 'string' && hook.command.includes(MARKER);
}

function ourGroups(settings: Record<string, unknown>): HookGroup[] {
	const hooks = settings.hooks as Record<string, unknown> | undefined;
	const groups = hooks && Array.isArray(hooks.Notification) ? (hooks.Notification as HookGroup[]) : [];
	return groups.filter((group) => (group.hooks ?? []).some(isOurs));
}
