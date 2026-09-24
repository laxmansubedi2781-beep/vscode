/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildInlineRequest, buildInlineSystemPrompt, stripFence } from '../../browser/cloudeideInlinePrompt.js';

/**
 * What goes into a file without anybody reading it first.
 *
 * `stripFence` is the one that has to be right. The model is told not to
 * wrap its answer in backticks and mostly does not — and "mostly" puts three
 * backticks at the top of somebody's function, which is a syntax error they
 * did not write and cannot explain.
 */
suite('CloudeIDE inline edit', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a fenced answer comes back as code', () => {
		assert.strictEqual(stripFence('```ts\nconst a = 1;\n```'), 'const a = 1;');
		assert.strictEqual(stripFence('```\nconst a = 1;\n```'), 'const a = 1;');
	});

	test('code that was never fenced is left exactly as it is', () => {
		assert.strictEqual(stripFence('const a = 1;'), 'const a = 1;');
	});

	test('indentation inside the fence survives', () => {
		// The whole point of the surrounding rules is that the answer lands
		// at the right depth. Trimming each line would undo that.
		assert.strictEqual(stripFence('```js\n  if (x) {\n    go();\n  }\n```'), '  if (x) {\n    go();\n  }');
	});

	test('backticks inside the code are not mistaken for the fence', () => {
		const code = 'const s = `hello ${name}`;';
		assert.strictEqual(stripFence('```ts\n' + code + '\n```'), code);
	});

	test('a lone fence marker is not treated as a wrapper', () => {
		// Only a matched pair is a fence. One at the top and none at the
		// bottom means the answer was cut off, and cutting more off it would
		// hide that.
		assert.strictEqual(stripFence('```ts\nconst a = 1;'), '```ts\nconst a = 1;');
	});

	test('the system prompt forbids explanation, in both shapes', () => {
		for (const replacing of [true, false]) {
			const prompt = buildInlineSystemPrompt(replacing);
			assert.ok(/code and nothing else/i.test(prompt), prompt);
			assert.ok(/no code fence/i.test(prompt), prompt);
		}
	});

	test('writing at a bare cursor is told not to repeat its surroundings', () => {
		const prompt = buildInlineSystemPrompt(false);
		assert.ok(/must not be repeated/i.test(prompt), prompt);
	});

	test('the request carries the selection, its surroundings and the instruction', () => {
		const request = buildInlineRequest({
			languageId: 'typescript',
			path: 'cart.ts',
			selection: 'const a = 1;',
			before: 'function go() {',
			after: '}',
			instruction: 'make it two',
		});
		assert.ok(request.includes('cart.ts'), request);
		assert.ok(request.includes('const a = 1;'), request);
		assert.ok(request.includes('function go() {'), request);
		assert.ok(request.includes('make it two'), request);
	});

	test('an empty selection asks to write rather than to replace', () => {
		const request = buildInlineRequest({
			languageId: 'typescript', path: 'a.ts', selection: '',
			before: 'x', after: 'y', instruction: 'add a test',
		});
		assert.ok(/write at this point/i.test(request), request);
		assert.ok(!/replace these lines/i.test(request), request);
	});
});
