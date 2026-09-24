/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { modeById, toolsForMode } from '../../browser/cloudeideModes.js';

/**
 * The fence. What a mode can reach is the whole of what a mode is, so it is
 * worth holding down: a change here that quietly re-admits `write_file` to
 * Ask mode would not fail anything else, and the first anybody knew of it
 * would be a question answered by four edited files.
 */
const ALL = [
	'list_files', 'read_file', 'search_files', 'find_symbol', 'find_references',
	'get_diagnostics', 'ask_user', 'run_command', 'edit_file', 'write_file',
];

suite('CloudeIDE agent modes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Agent gets everything it was given', () => {
		assert.deepStrictEqual(toolsForMode('agent', ALL), ALL);
	});

	test('Plan cannot change a file or run a command', () => {
		const tools = toolsForMode('plan', ALL);
		assert.ok(!tools.includes('edit_file'));
		assert.ok(!tools.includes('write_file'));
		assert.ok(!tools.includes('run_command'));
	});

	test('Plan can still read, search and ask', () => {
		const tools = toolsForMode('plan', ALL);
		// Working out an approach is exactly when a fork is worth raising,
		// and a plan built without reading the code is a guess.
		assert.ok(tools.includes('read_file'));
		assert.ok(tools.includes('find_references'));
		assert.ok(tools.includes('ask_user'));
	});

	test('Ask reads, and does not ask back', () => {
		const tools = toolsForMode('ask', ALL);
		assert.ok(tools.includes('read_file'));
		assert.ok(tools.includes('get_diagnostics'));
		// A question answered with a question is not an answer.
		assert.ok(!tools.includes('ask_user'));
		assert.ok(!tools.includes('edit_file'));
		assert.ok(!tools.includes('run_command'));
	});

	test('a mode filters the list it was given, it does not invent one', () => {
		// The panel drops run_command and ask_user when nothing can serve
		// them. A mode must not put them back.
		const narrow = ['read_file', 'edit_file'];
		assert.deepStrictEqual(toolsForMode('plan', narrow), ['read_file']);
		assert.deepStrictEqual(toolsForMode('agent', narrow), narrow);
	});

	test('an unknown mode falls back to Agent rather than to nothing', () => {
		assert.strictEqual(modeById(undefined), 'agent');
		assert.strictEqual(modeById('nonsense'), 'agent');
		assert.strictEqual(modeById('plan'), 'plan');
	});
});
