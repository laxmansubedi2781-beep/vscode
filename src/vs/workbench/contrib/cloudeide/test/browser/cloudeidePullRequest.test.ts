/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeChange } from '../../browser/cloudeidePullRequest.js';

/**
 * The title and body a pull request gets.
 *
 * Worth holding down because it is the part a reviewer sees first and the
 * part nobody checks: a title that ran to three hundred characters, or that
 * came out empty because the agent answered with a code block, would be a
 * bad pull request opened by a button somebody pressed in good faith.
 */
suite('CloudeIDE pull request description', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the first line becomes the title and the whole reply the body', () => {
		const { title, message } = describeChange('Split the header in two.\n\nNav moved out.', ['a.ts']);
		assert.strictEqual(title, 'Split the header in two.');
		assert.ok(message.includes('Nav moved out.'));
	});

	test('the files are listed in the body, where a reviewer looks first', () => {
		const { message } = describeChange('Did a thing.', ['src/a.ts', 'src/b.ts']);
		assert.ok(message.includes('- src/a.ts'), message);
		assert.ok(message.includes('- src/b.ts'), message);
	});

	test('a markdown heading does not carry its hashes into the title', () => {
		const { title } = describeChange('## Rename the hook\n\nEverywhere.', []);
		assert.strictEqual(title, 'Rename the hook');
	});

	test('a paragraph is cut at a sentence rather than mid-word', () => {
		const long = 'Moved the navigation out of the header component. ' +
			'It had no state of its own and three other files were importing it for that reason alone.';
		const { title } = describeChange(long, []);
		assert.ok(title.length <= 72, `title is ${title.length} characters`);
		// Cut at the sentence, and the full stop goes with it: a subject line
		// does not end in one, here or in a commit message.
		assert.strictEqual(title, 'Moved the navigation out of the header component');
		assert.ok(!title.endsWith('…'), 'cut at the sentence, not mid-word');
	});

	test('a reply with no usable first line still gets a title', () => {
		// An empty title would be rejected by the server, at the end of a
		// collection that has already uploaded the whole folder.
		const { title } = describeChange('   \n\n  ', ['a.ts']);
		assert.ok(title.length > 0);
	});

	test('leading blank lines are skipped rather than taken as the title', () => {
		const { title } = describeChange('\n\n\nFixed the badge.', []);
		assert.strictEqual(title, 'Fixed the badge.');
	});
});
