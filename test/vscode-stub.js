// A minimal stand-in for the `vscode` module, so the tracker, estimator and presenters run under plain
// Node for the tests. Require this file before anything from ../out.
const Module = require('module');

class EventEmitter {
	constructor() {
		this.listeners = [];
		this.event = (listener) => {
			this.listeners.push(listener);
			return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
		};
	}
	fire(value) {
		for (const listener of [...this.listeners]) listener(value);
	}
	dispose() {
		this.listeners = [];
	}
}

const settings = {};
const stub = {
	EventEmitter,
	workspace: { getConfiguration: () => ({ get: (key) => settings[key], update: async () => {} }) },
	settings
};

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	return request === 'vscode' ? require.resolve('./vscode-stub.js') : resolve.call(this, request, ...rest);
};
require.cache[require.resolve('./vscode-stub.js')].exports = stub;
module.exports = stub;
