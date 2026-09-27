// Scenario checks for the tracker paths that real transcripts rarely exercise. Run `npm test`.
require('./vscode-stub');
const assert = require('assert');
const { TurnTracker, activeMs } = require('../out/turnTracker');
const { Estimator } = require('../out/estimator');
const present = require('../out/present');

const T0 = Date.parse('2026-09-27T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const file = 'C:/x/projects/p/sess-1.jsonl';
const base = { sessionId: 'sess-1', cwd: 'C:/work/app' };
const human = (s, text) => ({ ...base, type: 'user', origin: { kind: 'human' }, timestamp: at(s), message: { role: 'user', content: text } });
const tool = (s, id, name, input = {}) => ({ ...base, type: 'assistant', timestamp: at(s), message: { id: `m${id}`, model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: { output_tokens: 10 } } });
const result = (s, id, extra = {}) => ({ ...base, type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra });
const reply = (s, text = 'Done.') => ({ ...base, type: 'assistant', timestamp: at(s), message: { id: `r${s}`, model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { output_tokens: 5 } } });
const interrupt = (s) => ({ ...base, type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });

function run(entries, options = {}) {
	const tracker = new TurnTracker({ staleMinutes: () => 30 });
	const log = { started: [], ended: [], waits: [] };
	tracker.onTurnStarted((e) => log.started.push(e));
	tracker.onTurnEnded((e) => log.ended.push(e));
	tracker.onWaitStarted((e) => log.waits.push(e));
	for (const entry of entries) {
		if (typeof entry === 'function') entry(tracker);
		else tracker.handle({ file, entry, replay: options.replay });
	}
	return { tracker, log };
}

// 1. A permission prompt from the hook: wait opens, the next transcript entry closes it, and the
//    waited time is not Claude's time.
{
	const { tracker, log } = run([
		human(0, 'deploy it'),
		tool(10, 't1', 'Bash', { command: 'npm run deploy' }),
		(tr) => tr.hookWait('sess-1', 'permission', 'Claude needs your permission to use Bash', T0 + 16_000),
		result(76, 't1'),
		reply(80)
	]);
	assert.strictEqual(log.waits.length, 1, 'hook wait fires');
	assert.strictEqual(log.waits[0].wait.kind, 'permission');
	const turn = log.ended[0].turn;
	assert.strictEqual(turn.status, 'done');
	assert.strictEqual(turn.waitedMs, 60_000, 'waited 60s for approval');
	assert.strictEqual(activeMs(turn), 20_000, 'active time excludes the wait');
	console.log('ok 1 hook permission wait: waited', turn.waitedMs / 1000, 's, active', activeMs(turn) / 1000, 's');
}

// 2. A stale hook event (the transcript already moved on) is ignored.
{
	const { log } = run([
		human(0, 'x'),
		tool(10, 't1', 'Edit', { file_path: 'C:/work/app/a.ts' }),
		result(12, 't1'),
		(tr) => tr.hookWait('sess-1', 'permission', 'late', T0 + 5_000),
		reply(20)
	]);
	assert.strictEqual(log.waits.length, 0, 'late hook event ignored');
	console.log('ok 2 stale hook event ignored');
}

// 3. ExitPlanMode is a wait; the estimate clock pauses while it is open.
{
	const { tracker, log } = run([human(0, 'plan the refactor'), tool(30, 'p1', 'ExitPlanMode', { plan: '...' })]);
	assert.strictEqual(log.waits[0].wait.kind, 'plan');
	const turn = tracker.getActiveTurns()[0].turn;
	const memory = new Map();
	const estimator = new Estimator({ get: (k) => memory.get(k), update: async (k, v) => memory.set(k, v) }, () => 200);
	const later = estimator.current(turn, T0 + 300_000);
	const muchLater = estimator.current(turn, T0 + 900_000);
	assert.strictEqual(later.remainingMs, muchLater.remainingMs, 'remaining time frozen while waiting');
	assert.strictEqual(present.liveState(turn, T0 + 300_000), 'waiting');
	console.log('ok 3 plan wait pauses the estimate; remaining stays', Math.round(later.remainingMs / 1000), 's');
}

// 4. Interrupt ends a working turn but not one waiting on background agents.
{
	const { log } = run([human(0, 'x'), tool(5, 't1', 'Bash'), interrupt(9)]);
	assert.strictEqual(log.ended[0].turn.status, 'interrupted');
	console.log('ok 4a interrupt ends a working turn');

	const agentLaunch = tool(5, 'a1', 'Agent', { description: 'Explore code', subagent_type: 'Explore', prompt: 'look' });
	const launched = result(6, 'a1', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'ag1' } });
	const handBack = { ...base, type: 'user', origin: { kind: 'peer' }, timestamp: at(100), message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message from="ag1">\n[Subagent hand-back] report' } };
	const { log: log2 } = run([human(0, 'x'), agentLaunch, launched, reply(10, 'Launched an agent.'), interrupt(40), handBack, reply(110, 'The agent found 3 issues.')]);
	assert.strictEqual(log2.ended.length, 1, 'one job');
	assert.strictEqual(log2.ended[0].turn.status, 'done');
	assert.strictEqual(log2.ended[0].turn.endedAt, T0 + 110_000, 'ends after the hand-back is processed');
	console.log('ok 4b stop-hook interrupt ignored in background phase; job ends at the hand-back reply');
}

// 5. A background notification only becomes a turn when Claude answers it.
{
	const note = { ...base, type: 'user', origin: { kind: 'task-notification' }, timestamp: at(0), message: { role: 'user', content: '<task-notification><task-id>b1</task-id><status>completed</status><summary>Build finished</summary></task-notification>' } };
	const unanswered = run([note, human(5, 'next thing')]);
	assert.strictEqual(unanswered.log.started.length, 1, 'only the human turn');
	assert.strictEqual(unanswered.log.started[0].turn.trigger, 'human');
	const answered = run([note, reply(8, 'The build passed.')]);
	assert.strictEqual(answered.log.started[0].turn.trigger, 'background');
	assert.strictEqual(answered.log.started[0].turn.prompt, 'Background task: Build finished');
	console.log('ok 5 automatic turns start only when answered');
}

// 6. Replay flag is carried onto events; usage is counted once per message id.
{
	const dup = tool(3, 't1', 'Read', { file_path: 'a' });
	const { log } = run([human(0, 'x'), dup, { ...dup, message: { ...dup.message, content: [{ type: 'text', text: 'hm' }] } }, result(4, 't1'), reply(5)], { replay: true });
	assert.ok(log.started[0].replay && log.ended[0].replay, 'replay flagged');
	assert.strictEqual(log.ended[0].turn.outputTokens, 15, 'message m t1 counted once (10) + reply (5)');
	console.log('ok 6 replay flag carried; usage deduplicated');
}

// 7. Usage limit ends the turn with a reset time; auth error is an error.
{
	const limit = { ...base, type: 'assistant', timestamp: at(9), isApiErrorMessage: true, error: 'rate_limit', quotaLimits: { status: 'rejected', resetsAt: (T0 + 7_200_000) / 1000 }, message: { id: 'q', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your session limit · resets 12:25pm" }] } };
	const { log } = run([human(0, 'x'), limit]);
	const turn = log.ended[0].turn;
	assert.strictEqual(turn.status, 'limited');
	assert.strictEqual(turn.limitResetsAt, T0 + 7_200_000);
	assert.match(present.errorAdvice(turn), /^resets at /);
	console.log('ok 7 usage limit ->', present.errorAdvice(turn));
}

// 8. Files: an Edit with a structured patch and a file-history backup gives an exact before-state.
{
	const backup = { type: 'file-history-delta', timestamp: at(2), trackingPath: 'src\\a.ts', backup: { backupFileName: 'abc@v1', realParentDir: 'C:\\work\\app\\src' } };
	const edit = tool(3, 'e1', 'Edit', { file_path: 'C:\\work\\app\\src\\a.ts' });
	const edited = result(4, 'e1', { toolUseResult: { filePath: 'C:\\work\\app\\src\\a.ts', structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] } });
	const tracker = new TurnTracker({ claudeHome: () => 'C:\\home\\.claude' });
	let ended;
	tracker.onTurnEnded((e) => (ended = e.turn));
	for (const entry of [human(0, 'x'), backup, edit, edited, reply(6)]) tracker.handle({ file, entry });
	const files = present.changedFiles(ended);
	assert.strictEqual(files.length, 1);
	assert.strictEqual(files[0].added, 2);
	assert.strictEqual(files[0].removed, 1);
	assert.ok(files[0].before.backup.endsWith('file-history\\sess-1\\abc@v1') || files[0].before.backup.endsWith('file-history/sess-1/abc@v1'));
	console.log('ok 8 file change +2 -1 with backup', files[0].before.backup);
}

// 9. A task list left open by an interrupted prompt is not the next prompt's progress.
{
	const todos = [
		{ content: 'a', status: 'completed' },
		{ content: 'b', status: 'in_progress', activeForm: 'Doing b' },
		{ content: 'c', status: 'pending' }
	];
	const { tracker } = run([human(0, 'multi-step task'), tool(5, 'td', 'TodoWrite', { todos }), interrupt(9), human(30, 'unrelated question')]);
	const { session, turn } = tracker.getActiveTurns()[0];
	assert.strictEqual(present.taskProgress(session, turn), undefined, 'stale list hidden');
	tracker.handle({ file, entry: tool(35, 'td2', 'TodoWrite', { todos }) });
	assert.deepStrictEqual(present.taskProgress(session, turn), { done: 1, total: 3, current: 'Doing b' }, 'rewritten list shows');
	console.log('ok 9 stale task list hidden until rewritten in this turn');
}

console.log('all scenarios passed');
