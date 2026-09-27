import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileBefore, FileChange } from './types';

/** Serves the pre-edit content of a file: Claude Code's own backup, or nothing for a new file. */
export class BeforeContentProvider implements vscode.TextDocumentContentProvider {
	static readonly scheme = 'claude-monitor-before';

	provideTextDocumentContent(uri: vscode.Uri): string {
		let before: FileBefore = {};
		try {
			before = JSON.parse(uri.query) as FileBefore;
		} catch {
			/* malformed query: treat as an empty file */
		}
		if (before.backup) {
			try {
				return fs.readFileSync(before.backup, 'utf8');
			} catch {
				return '';
			}
		}
		return '';
	}
}

function beforeUri(change: FileChange): vscode.Uri {
	// The original path keeps the language (and so the highlighting) of the real file.
	return vscode.Uri.file(change.path).with({
		scheme: BeforeContentProvider.scheme,
		query: JSON.stringify(change.before ?? {})
	});
}

function hasBefore(change: FileChange): boolean {
	return !!change.before && (!!change.before.created || (!!change.before.backup && fs.existsSync(change.before.backup)));
}

/**
 * Shows what a turn changed: each file against its state just before Claude first touched it in that
 * turn. Several files open together in the multi-file changes editor where VS Code has one.
 */
export async function reviewChanges(files: FileChange[], title: string): Promise<void> {
	if (!files.length) {
		void vscode.window.showInformationMessage('This prompt did not change any files.');
		return;
	}
	const exact = files.filter(hasBefore);
	const rest = files.filter((file) => !hasBefore(file));

	if (exact.length > 1) {
		const resources = exact.map((file) => {
			const current = vscode.Uri.file(file.path);
			return [current, beforeUri(file), current];
		});
		try {
			await vscode.commands.executeCommand('vscode.changes', title, resources);
			if (rest.length) {
				await offerFallback(rest);
			}
			return;
		} catch {
			/* older VS Code without the changes editor: pick one file at a time below */
		}
	}
	if (files.length === 1) {
		await openOne(files[0]);
		return;
	}
	const picked = await vscode.window.showQuickPick(
		files.map((file) => ({
			label: path.basename(file.path),
			description: `+${file.added} −${file.removed}${file.before?.created ? ' · new' : ''}`,
			detail: file.path,
			file
		})),
		{ placeHolder: `${title} — pick a file to compare`, matchOnDetail: true }
	);
	if (picked) {
		await openOne(picked.file);
	}
}

export async function openOne(file: FileChange): Promise<void> {
	const current = vscode.Uri.file(file.path);
	if (hasBefore(file)) {
		const label = file.before?.created ? 'new file' : 'before ↔ now';
		await vscode.commands.executeCommand('vscode.diff', beforeUri(file), current, `${path.basename(file.path)} (${label})`);
		return;
	}
	// No backup to compare with (checkpointing off, or an old turn): the git diff is the next best thing.
	try {
		await vscode.commands.executeCommand('git.openChange', current);
	} catch {
		await vscode.window.showTextDocument(current, { preview: true });
	}
}

async function offerFallback(files: FileChange[]): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		`${files.length} more ${files.length === 1 ? 'file has' : 'files have'} no saved before-state to compare with.`,
		'Show Git Diff'
	);
	if (choice) {
		for (const file of files) {
			await openOne(file);
		}
	}
}
