// Replays every transcript on this machine (main + subagent files, merged by timestamp) through the
// compiled tracker and reports what it saw: how turns start and end, waits, background phases, file
// changes. Run `npm run compile` first. Pass a session id to trace that session turn by turn:
//
//   node test/replay.js                      summary over all transcripts
//   node test/replay.js <session-id>         plus a per-turn trace of one session
//
// Compare the summary with the raw transcripts when changing the state machine: a jump in abandoned
// or interrupted turns, or a drop in waits, usually means a transcript shape was misread.
require('./vscode-stub');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TurnTracker, activeMs } = require('../out/turnTracker');
const { Estimator } = require('../out/estimator');
const present = require('../out/present');

const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projects = path.join(home, 'projects');
const only = process.argv[2];

function readEntries(file) {
	const out = [];
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return out;
	}
	let last = 0;
	for (const line of text.split('\n')) {
		if (!line.trim().startsWith('{')) continue;
		try {
			const entry = JSON.parse(line);
			const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
			if (Number.isFinite(at)) last = at;
			out.push({ file, entry, sortAt: last });
		} catch {
			/* a line still being written */
		}
	}
	return out;
}

const tracker = new TurnTracker({ claudeHome: () => home, staleMinutes: () => 30 });
const memory = new Map();
const estimator = new Estimator({ get: (k) => memory.get(k), update: async (k, v) => memory.set(k, v) }, () => 200);

const stats = { started: {}, ended: {}, endedBy: {}, waits: {}, waitMs: [], background: 0, files: 0, exact: 0, fileTurns: 0 };
const inc = (o, k) => (o[k] = (o[k] || 0) + 1);
const traces = [];
const phases = new Map();

tracker.onTurnStarted(({ turn }) => inc(stats.started, turn.trigger));
tracker.onWaitStarted(({ wait }) => inc(stats.waits, wait.kind));
tracker.onTurnUpdated(({ session, turn }) => {
	const key = present.turnKey(turn);
	if (turn.phase === 'background' && phases.get(key) !== 'background') {
		stats.background++;
		if (session.sessionId === only) {
			const agents = present.backgroundAgents(session, turn, turn.lastActivityAt).map((a) => a.description);
			traces.push(`  .. waiting on background agents: ${agents.join(' | ') || '(reports on their way)'}`);
		}
	}
	phases.set(key, turn.phase);
});
tracker.onTurnEnded(({ session, turn }) => {
	inc(stats.ended, turn.status);
	inc(stats.endedBy, turn.endedBy);
	if (turn.waitedMs > 0) stats.waitMs.push(turn.waitedMs);
	const files = present.changedFiles(turn);
	if (files.length) {
		stats.fileTurns++;
		stats.files += files.length;
		stats.exact += files.filter((f) => f.before).length;
	}
	estimator.record(turn);
	if (session.sessionId === only) {
		const wall = ((turn.endedAt - turn.startedAt) / 1000).toFixed(0);
		const active = (activeMs(turn) / 1000).toFixed(0);
		traces.push(
			`${new Date(turn.startedAt).toISOString().slice(11, 19)} [${turn.trigger}] ${turn.status}/${turn.endedBy} ` +
				`wall=${wall}s active=${active}s tools=${turn.toolCount} agents=${turn.agentIds.length} files=${files.length} ` +
				`waits=${turn.waitCount} :: ${turn.prompt.slice(0, 70)}`
		);
		if (turn.finalText) traces.push(`     -> ${present.headline(turn.finalText, 110)}`);
		if (turn.errorMessage) traces.push(`     !! ${present.errorAdvice(turn)}`);
	}
});

let sessions = 0;
for (const project of fs.readdirSync(projects)) {
	const dir = path.join(projects, project);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.jsonl')) continue;
		const sessionId = name.slice(0, -'.jsonl'.length);
		if (only && sessionId !== only) continue;
		const entries = readEntries(path.join(dir, name));
		const agents = path.join(dir, sessionId, 'subagents');
		if (fs.existsSync(agents)) {
			for (const file of fs.readdirSync(agents)) {
				if (file.endsWith('.jsonl')) entries.push(...readEntries(path.join(agents, file)));
			}
		}
		entries.sort((a, b) => a.sortAt - b.sortAt);
		// The extension sweeps on a timer; here the clock is the transcript's own, per session.
		let lastSweep = entries.length ? entries[0].sortAt : 0;
		for (const e of entries) {
			if (e.sortAt - lastSweep > 10_000) {
				tracker.sweep(e.sortAt);
				lastSweep = e.sortAt;
			}
			tracker.handle({ file: e.file, entry: e.entry });
		}
		tracker.sweep(lastSweep + 31 * 60_000);
		sessions++;
	}
}

const q = (values, p) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;
};
console.log('sessions', sessions);
console.log('turns started by trigger', stats.started);
console.log('turns ended by status', stats.ended);
console.log('ended by', stats.endedBy);
console.log(
	'waits by kind',
	stats.waits,
	`median ${(q(stats.waitMs, 0.5) / 1000).toFixed(0)}s, p90 ${(q(stats.waitMs, 0.9) / 1000).toFixed(0)}s`
);
console.log('turns held open for background agents', stats.background);
console.log(`turns with file changes ${stats.fileTurns}, files ${stats.files}, with an exact before-state ${stats.exact}`);
console.log('estimator records', estimator.size);
if (only) {
	console.log('\n--- trace');
	for (const line of traces) console.log(line);
}
