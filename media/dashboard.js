// Claude Monitor panel. State arrives from the extension once a second while the panel is visible.
// Everything shown comes from Claude Code transcripts, so it is always set as text, never as HTML.
// Cards are updated in place rather than rebuilt, so keyboard focus survives the refresh.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const saved = vscode.getState() || {};
	const expanded = new Set(saved.expanded || []);
	const cards = new Map();
	const announced = new Set();

	const $ = (id) => document.getElementById(id);
	const send = (command, ...args) => vscode.postMessage({ command, args });

	// ------------------------------------------------------------------ formatting

	function clock(ms) {
		const total = Math.max(0, Math.round(ms / 1000));
		const minutes = Math.floor(total / 60);
		const seconds = total % 60;
		return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
	}

	function duration(ms) {
		const total = Math.max(0, Math.round(ms / 1000));
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const seconds = total % 60;
		const pad = (n) => (n < 10 ? `0${n}` : String(n));
		if (hours > 0) return `${hours}h ${pad(minutes)}m`;
		if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
		return `${seconds}s`;
	}

	function when(at, now) {
		const date = new Date(at);
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		if (at >= midnight.getTime()) {
			return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		}
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function plural(count, one, many) {
		return `${count} ${count === 1 ? one : many || `${one}s`}`;
	}

	function filesText(totals) {
		if (!totals || !totals.count) return '';
		const lines = totals.added || totals.removed ? ` +${totals.added} −${totals.removed}` : '';
		return `${plural(totals.count, 'file')}${lines}`;
	}

	// ------------------------------------------------------------------ icons (static paths only)

	const ICONS = {
		spinner: 'M8 2.5a5.5 5.5 0 1 0 5.5 5.5',
		bell: 'M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8L4 11zM6.5 13.5a1.5 1.5 0 0 0 3 0',
		bellOff: 'M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8L4 11zM6.5 13.5a1.5 1.5 0 0 0 3 0M2 2l12 12',
		check: 'M3 8.5l3 3 7-7',
		cross: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
		stop: 'M5 5h6v6H5z',
		clock: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5v3.2l2.2 1.4',
		agents:
			'M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM10.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M7 13c0-2 1.6-3.5 3.5-3.5S14 11 14 13',
		retry: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5',
		window: 'M2.5 3.5h11v9h-11zM2.5 6h11'
	};

	function icon(name, extraClass) {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('class', `icon${extraClass ? ` ${extraClass}` : ''}`);
		svg.setAttribute('aria-hidden', 'true');
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', ICONS[name]);
		svg.appendChild(path);
		return svg;
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function button(label, className, onClick) {
		const node = el('button', className, label);
		node.type = 'button';
		node.addEventListener('click', onClick);
		return node;
	}

	// ------------------------------------------------------------------ now

	const STATE_WORDS = {
		question: ['bell', 'Asking you'],
		plan: ['bell', 'Plan to approve'],
		permission: ['bell', 'Needs permission'],
		input: ['bell', 'Needs your input']
	};

	function chipFor(card) {
		if (card.state === 'waiting' && card.wait) return STATE_WORDS[card.wait.kind] || ['bell', 'Needs you'];
		if (card.state === 'retrying' && card.retry) return ['retry', `Retrying ${card.retry.attempt}/${card.retry.max}`];
		if (card.state === 'background') return ['agents', 'Agents working'];
		return ['spinner', card.trigger === 'human' ? 'Working' : 'Working · follow-up'];
	}

	function createCard() {
		const node = el('article', 'card');
		const head = el('div', 'card-head');
		const chip = el('span', 'chip');
		const where = el('span', 'where');
		head.append(chip, where);
		const title = el('p', 'title');
		const prompt = el('p', 'prompt');
		const ask = el('p', 'ask');
		const clockRow = el('div', 'clock');
		const elapsed = el('strong');
		const eta = el('span');
		clockRow.append(elapsed, eta);
		const meter = el('div', 'meter');
		meter.setAttribute('role', 'progressbar');
		meter.setAttribute('aria-valuemin', '0');
		meter.setAttribute('aria-valuemax', '100');
		const fill = el('div');
		meter.appendChild(fill);
		const step = el('p', 'step');
		const facts = el('p', 'facts');
		const agents = el('ul', 'agents');
		const actions = el('div', 'actions');
		const focus = button('Open Claude', 'btn primary', () => send('claudePromptMonitor.focusClaude', node._card.sessionId));
		focus.style.flex = '0 0 auto';
		const changes = button('Changes', 'btn secondary', () => send('claudePromptMonitor.reviewChanges', node._card.key));
		const transcript = button('Transcript', 'btn secondary', () =>
			send('claudePromptMonitor.openTranscript', node._card.sessionId)
		);
		actions.append(focus, changes, transcript);
		node.append(head, title, prompt, ask, clockRow, meter, step, facts, agents, actions);
		node._parts = { chip, where, title, prompt, ask, elapsed, eta, meter, fill, step, facts, agents, focus, changes };
		return node;
	}

	function fillCard(node, card) {
		const p = node._parts;
		node._card = card;
		node.dataset.state = card.state;

		const [iconName, word] = chipFor(card);
		p.chip.replaceChildren(icon(iconName, iconName === 'spinner' ? 'spin' : ''), document.createTextNode(word));
		p.where.textContent = card.queued ? `${card.project} · ${card.queued} queued` : card.project;

		const heading = card.title || card.prompt;
		p.title.textContent = heading;
		p.prompt.textContent = card.title ? card.prompt : '';
		p.prompt.hidden = !card.title;

		if (card.state === 'waiting' && card.wait) {
			const detail =
				card.wait.detail ||
				(card.wait.kind === 'plan' ? 'A plan is ready for your approval.' : 'Claude is waiting for you.');
			p.ask.textContent = `${detail} · waiting ${clock(card.wait.ms)}`;
			p.ask.hidden = false;
		} else if (card.state === 'retrying' && card.retry) {
			p.ask.textContent = card.retry.message;
			p.ask.hidden = false;
		} else {
			p.ask.hidden = true;
		}

		p.elapsed.textContent = clock(card.elapsedMs);
		if (card.state === 'waiting') {
			p.eta.textContent = 'clock paused while Claude waits';
		} else if (card.state === 'background') {
			p.eta.textContent = `reply done · ${plural(card.agents.length, 'agent')} out`;
		} else {
			p.eta.textContent = `~${clock(card.remainingMs)} left${card.confident ? '' : ' (rough)'}`;
		}

		const percent = Math.round(Math.max(0, Math.min(1, card.progress)) * 100);
		p.meter.hidden = card.state === 'background';
		p.fill.style.width = `${percent}%`;
		p.meter.setAttribute('aria-valuenow', String(percent));
		p.meter.setAttribute('aria-label', `Estimated progress ${percent}%`);

		const showStep = card.state === 'working' || card.state === 'retrying';
		p.step.hidden = !showStep;
		if (showStep) {
			const running = card.stepMs > 5000 ? ` · ${clock(card.stepMs)}` : '';
			p.step.replaceChildren(el('b', '', card.step), el('span', '', `${running}${card.stepDetail ? ` — ${card.stepDetail}` : ''}`));
		}

		const facts = [plural(card.tools, 'tool')];
		if (card.tasks) facts.push(`tasks ${card.tasks.done}/${card.tasks.total}${card.tasks.current ? ` · ${card.tasks.current}` : ''}`);
		const files = filesText(card.files);
		if (files) facts.push(files);
		if (card.errors) facts.push(`${card.errors} failed`);
		p.facts.textContent = facts.join(' · ');

		p.agents.replaceChildren(
			...card.agents.slice(0, 4).map((agent) => {
				const li = el('li');
				const dot = el('span', `dot${agent.status === 'running' ? '' : ' done'}`);
				const text = el('span', 'text');
				text.append(
					document.createTextNode(agent.description),
					el('span', '', ` · ${agent.status === 'running' ? plural(agent.tools, 'tool') : 'reporting back'}${agent.lastStep && agent.status === 'running' ? ` · ${agent.lastStep}` : ''}`)
				);
				li.append(dot, text);
				return li;
			})
		);
		p.agents.hidden = !card.agents.length;
		p.focus.hidden = !card.canFocus;
		p.changes.hidden = !card.files.count;
	}

	function renderNow(state) {
		const container = $('now');
		const keys = new Set(state.active.map((card) => card.key));
		for (const [key, node] of cards) {
			if (!keys.has(key)) {
				node.remove();
				cards.delete(key);
			}
		}
		state.active.forEach((card, index) => {
			let node = cards.get(card.key);
			if (!node) {
				node = createCard();
				cards.set(card.key, node);
			}
			fillCard(node, card);
			if (container.children[index] !== node) {
				container.insertBefore(node, container.children[index] || null);
			}
			const waitKey = card.wait ? `${card.key}:${card.wait.kind}` : '';
			if (waitKey && !announced.has(waitKey)) {
				announced.add(waitKey);
				$('live').textContent = `Claude needs you in ${card.project}: ${card.wait.detail || card.wait.kind}`;
			}
		});
		$('idle').hidden = state.active.length > 0;
	}

	function renderLimit(state) {
		const box = $('limit');
		if (!state.limitResetsAt) {
			box.hidden = true;
			return;
		}
		const at = new Date(state.limitResetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		box.replaceChildren(icon('clock'), document.createTextNode(`Usage limit reached — resets at ${at}.`));
		box.hidden = false;
	}

	// ------------------------------------------------------------------ today

	function tile(label, value, note) {
		const node = el('div', 'tile');
		node.append(el('div', 'tile-label', label), el('div', 'tile-value', value));
		if (note) node.append(el('div', 'tile-note', note));
		return node;
	}

	function renderToday(today) {
		$('today').replaceChildren(
			tile('Prompts', String(today.prompts), today.prompts ? `${duration(today.medianMs)} median` : 'none yet'),
			tile('Claude time', duration(today.activeMs), today.failed ? `${today.failed} failed` : 'excludes waiting'),
			tile('Waiting on you', duration(today.waitedMs), today.waits ? plural(today.waits, 'time') : 'never blocked'),
			tile('Files changed', String(today.files), today.files ? `+${today.added} −${today.removed}` : 'nothing yet')
		);
	}

	// ------------------------------------------------------------------ recent

	const STATUS_ICON = { done: 'check', error: 'cross', limited: 'clock', interrupted: 'stop', abandoned: 'stop' };
	const STATUS_WORD = {
		done: 'Finished',
		error: 'Stopped with an error',
		limited: 'Hit a usage limit',
		interrupted: 'Interrupted',
		abandoned: 'Abandoned'
	};

	function renderRecent(items, now) {
		const list = $('recent');
		list.replaceChildren(
			...items.map((item) => {
				const li = el('li');
				const row = el('button', 'recent-row');
				row.type = 'button';
				row.setAttribute('aria-expanded', String(expanded.has(item.key)));
				const status = el('span', `status ${item.status}`);
				status.append(icon(STATUS_ICON[item.status] || 'check'));
				status.setAttribute('role', 'img');
				status.setAttribute('aria-label', STATUS_WORD[item.status] || item.status);
				status.title = STATUS_WORD[item.status] || item.status;
				const meta = [item.project, duration(item.durationMs)];
				const files = filesText(item.totals);
				if (files) meta.push(files);
				if (item.status !== 'done') meta.push(STATUS_WORD[item.status] || item.status);
				row.append(
					status,
					el('span', 'recent-title', item.prompt),
					el('span', 'recent-when', when(item.endedAt, now)),
					el('span', 'recent-meta', meta.join(' · '))
				);
				const detail = el('div', 'recent-detail');
				detail.hidden = !expanded.has(item.key);
				row.addEventListener('click', () => {
					if (expanded.has(item.key)) expanded.delete(item.key);
					else expanded.add(item.key);
					detail.hidden = !expanded.has(item.key);
					row.setAttribute('aria-expanded', String(!detail.hidden));
					vscode.setState({ expanded: [...expanded] });
				});
				fillDetail(detail, item);
				li.append(row, detail);
				return li;
			})
		);
		$('recent-empty').hidden = items.length > 0;
		list.hidden = items.length === 0;
	}

	function fillDetail(detail, item) {
		if (item.headline) {
			detail.append(el('p', item.status === 'done' ? 'quote' : '', item.status === 'done' ? `“${item.headline}”` : item.headline));
		}
		if (item.title) detail.append(el('p', 'facts', `Conversation: ${item.title}`));
		const facts = [plural(item.tools, 'tool call')];
		if (item.agents) facts.push(plural(item.agents, 'agent'));
		if (item.tasks) facts.push(`tasks ${item.tasks}`);
		if (item.waitedMs >= 5000) facts.push(`waited ${duration(item.waitedMs)} for you`);
		if (item.errors) facts.push(`${item.errors} failed tool ${item.errors === 1 ? 'call' : 'calls'}`);
		if (item.trigger !== 'human') facts.push('started by a background task');
		detail.append(el('p', 'facts', facts.join(' · ')));
		if (item.files.length) {
			const files = el('ul', 'files');
			for (const file of item.files.slice(0, 12)) {
				const li = el('li');
				const link = button(file.name, 'link', () => send('claudePromptMonitor.openFileChange', item.key, file.path));
				link.title = `Compare ${file.path} with before this prompt`;
				li.append(link, el('span', 'delta', `${file.created ? 'new · ' : ''}+${file.added} −${file.removed}`));
				files.append(li);
			}
			if (item.files.length > 12) files.append(el('li', 'facts', `and ${item.files.length - 12} more`));
			detail.append(files);
		}
		const actions = el('div', 'actions');
		if (item.files.length) {
			actions.append(button('Review changes', 'btn primary', () => send('claudePromptMonitor.reviewChanges', item.key)));
			actions.lastChild.style.flex = '0 0 auto';
		}
		actions.append(
			button('Copy prompt', 'btn secondary', () => send('claudePromptMonitor.copyPrompt', item.key)),
			button('Transcript', 'btn secondary', () => send('claudePromptMonitor.openTranscript', item.sessionId))
		);
		if (item.canFocus) {
			actions.append(button('Open Claude', 'btn secondary', () => send('claudePromptMonitor.focusClaude', item.sessionId)));
		}
		detail.append(actions);
	}

	// ------------------------------------------------------------------ chrome

	function renderToolbar(state) {
		const widget = $('widget');
		widget.hidden = !state.windows;
		widget.replaceChildren(icon('window'), document.createTextNode(state.widgetRunning ? 'Close desktop widget' : 'Open desktop widget'));
		const bell = $('bell');
		bell.setAttribute('aria-pressed', String(state.notificationsOn));
		bell.setAttribute('aria-label', state.notificationsOn ? 'Completion notifications on' : 'Completion notifications off');
		bell.title = state.notificationsOn ? 'Notifications on — click to turn off' : 'Notifications off — click to turn on';
		bell.replaceChildren(icon(state.notificationsOn ? 'bell' : 'bellOff'));
	}

	let hooksShown = null;

	function renderHooks(state) {
		// Rebuilt only when it changes, so a focused button is not replaced under the keyboard.
		if (state.hooksInstalled === hooksShown) return;
		hooksShown = state.hooksInstalled;
		const footer = $('hooks');
		if (state.hooksInstalled) {
			footer.replaceChildren(
				el('p', '', 'Exact permission alerts are on: Claude Code tells the monitor the moment it shows a permission prompt.'),
				button('Remove the hook', 'link', () => send('claudePromptMonitor.uninstallHooks'))
			);
		} else {
			footer.replaceChildren(
				el(
					'p',
					'',
					'Questions and plan approvals are detected from the transcript. Permission prompts leave no trace there until answered — enable the hook to be alerted to those too.'
				),
				button('Enable permission alerts', 'btn secondary', () => send('claudePromptMonitor.installHooks'))
			);
		}
	}

	$('widget').addEventListener('click', () => send('claudePromptMonitor.toggleOverlay'));
	$('bell').addEventListener('click', () => send('claudePromptMonitor.toggleNotifications'));
	$('clear').addEventListener('click', () => send('claudePromptMonitor.clearRecent'));

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || message.type !== 'state') return;
		const state = message.state;
		renderToolbar(state);
		renderLimit(state);
		renderNow(state);
		if (state.today) renderToday(state.today);
		if (state.recent) renderRecent(state.recent, state.now);
		renderHooks(state);
	});

	vscode.postMessage({ command: 'ready' });
})();
