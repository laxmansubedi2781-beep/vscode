/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findMention, mentionedFiles } from '../../browser/cloudeideMentions.js';

/**
 * The two pure decisions behind `@`: when the list should open, and which
 * files the finished sentence named. Both are the sort of thing that works
 * for the case you thought of and quietly misfires on the one you did not —
 * an email address, a decorator, a full stop at the end of a sentence.
 */
suite('CloudeIDE mentions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('typing @ at the start of a word opens the list', () => {
		assert.deepStrictEqual(findMention('@', 1), { start: 0, query: '' });
		assert.deepStrictEqual(findMention('fix @car', 8), { start: 4, query: 'car' });
	});

	test('an @ inside a word is not somebody asking for a file', () => {
		// An email address, a decorator, a handle. Opening a file list over
		// any of these would be the feature getting in the way.
		assert.strictEqual(findMention('me@example.com', 14), undefined);
		assert.strictEqual(findMention('use foo@bar', 11), undefined);
	});

	test('the list closes once the sentence moves on', () => {
		// A space ends the mention: the words after the file name are the
		// rest of the question, not a longer path.
		assert.strictEqual(findMention('fix @Cart.tsx and the badge', 27), undefined);
	});

	test('only what is before the caret counts', () => {
		// Somebody who goes back to edit the front of a sentence should not
		// be offered files because of an @ further along.
		assert.strictEqual(findMention('hello @Cart.tsx', 3), undefined);
	});

	test('a finished sentence gives up the files it named', () => {
		assert.deepStrictEqual(
			mentionedFiles('use @src/Header.tsx in @src/Cart.tsx too'),
			['src/Header.tsx', 'src/Cart.tsx']);
	});

	test('a full stop at the end of the sentence is not part of the path', () => {
		assert.deepStrictEqual(mentionedFiles('look at @src/Cart.tsx.'), ['src/Cart.tsx']);
		assert.deepStrictEqual(mentionedFiles('check @a.ts, @b.ts'), ['a.ts', 'b.ts']);
	});

	test('the same file named twice is one file', () => {
		assert.deepStrictEqual(mentionedFiles('@a.ts and @a.ts again'), ['a.ts']);
	});

	test('an email address in the question names no files', () => {
		assert.deepStrictEqual(mentionedFiles('mail me@example.com about it'), []);
	});
});
