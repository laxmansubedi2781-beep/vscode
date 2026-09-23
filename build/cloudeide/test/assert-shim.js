/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Just enough of node's `assert` to run these tests in a browser. The tests
// import it the way every other test in this repository does; esbuild is told
// to resolve that import here instead of at a node built-in.

function fail(message, fallback) { throw new Error(message || fallback); }
function ok(value, message) { if (!value) { fail(message, 'expected a truthy value'); } }
function strictEqual(actual, expected, message) {
	if (!Object.is(actual, expected)) { fail(message, `expected ${String(expected)}, got ${String(actual)}`); }
}
function notStrictEqual(actual, expected, message) {
	if (Object.is(actual, expected)) { fail(message, `expected something other than ${String(expected)}`); }
}
function deepStrictEqual(actual, expected, message) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(message, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}
async function rejects(promise, message) {
	try { await (typeof promise === 'function' ? promise() : promise); } catch { return; }
	fail(message, 'expected a rejection');
}
function throws(fn, message) {
	try { fn(); } catch { return; }
	fail(message, 'expected a throw');
}

const assert = Object.assign(ok, {
	ok, strictEqual, notStrictEqual, deepStrictEqual, rejects, throws,
	fail: message => fail(message, 'failed'),
});

export default assert;
export { ok, strictEqual, notStrictEqual, deepStrictEqual, rejects, throws };
