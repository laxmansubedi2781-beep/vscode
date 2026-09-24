/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applySlash, findSlash, matchingCommands } from '../../browser/cloudeideCommands.js';

/**
 * When the command list opens, and what a command turns into.
 *
 * The failure worth guarding is the quiet one: a `/` somewhere in the middle
 * of a sentence — a path, a date, a fraction — opening a menu over what
 * somebody was typing, or a word that is not a command being silently turned
 * into one that is.
 */
suite('CloudeIDE slash commands', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the list opens on a slash at the very start', () => {
		assert.deepStrictEqual(findSlash('/', 1), { query: '' });
		assert.deepStrictEqual(findSlash('/pl', 3), { query: 'pl' });
	});

	test('a slash anywhere else is a path, a date or a fraction', () => {
		assert.strictEqual(findSlash('look in src/utils', 17), undefined);
		assert.strictEqual(findSlash('on 12/05 it broke', 17), undefined);
	});

	test('the list closes once the caret moves past the command', () => {
		// "/test the cart ones" is a real thing to type; the menu should be
		// gone by the time somebody is writing the rest of it.
		assert.strictEqual(findSlash('/test the cart ones', 19), undefined);
		// Still open while the caret is inside the word itself.
		assert.deepStrictEqual(findSlash('/test the cart ones', 3), { query: 'test' });
	});

	test('matching is by prefix, so half a word still finds it', () => {
		assert.deepStrictEqual(matchingCommands('pl').map(c => c.name), ['plan']);
		assert.ok(matchingCommands('').length > 3);
		assert.deepStrictEqual(matchingCommands('zzz'), []);
	});

	test('a mode command switches the mode and sends what was typed after it', () => {
		const { text, mode } = applySlash('/plan split the header');
		assert.strictEqual(mode, 'plan');
		assert.strictEqual(text, 'split the header');
	});

	test('an expanding command puts its sentence in front of the rest', () => {
		const { text } = applySlash('/test the cart ones');
		assert.ok(text.includes('Run this project'), text);
		// What was typed after it survives — the expansion leads, it does not
		// replace.
		assert.ok(text.includes('the cart ones'), text);
	});

	test('a local command is handled here and nothing is sent', () => {
		assert.strictEqual(applySlash('/undo').local, 'undo');
		assert.strictEqual(applySlash('/pr').local, 'pr');
		assert.strictEqual(applySlash('/clear').local, 'clear');
	});

	test('a word that is not a command is sent exactly as typed', () => {
		// Guessing at the nearest command would answer a question nobody
		// asked, and "/" is an ordinary way to start a sentence about a path.
		const { text, mode, local } = applySlash('/usr/local/bin is missing');
		assert.strictEqual(text, '/usr/local/bin is missing');
		assert.strictEqual(mode, undefined);
		assert.strictEqual(local, undefined);
	});

	test('a command on its own still carries its sentence', () => {
		const { text } = applySlash('/review');
		assert.ok(text.length > 20, text);
	});
});
