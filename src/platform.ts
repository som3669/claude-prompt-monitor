import * as path from 'path';

/** The absolute path, so a shadowed `powershell` on PATH cannot change what gets launched. */
export function powershellPath(): string {
	const root = process.env.SystemRoot || 'C:\\Windows';
	return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
