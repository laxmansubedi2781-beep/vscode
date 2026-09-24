/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the model is told when somebody edits in place.
 *
 * A different job from the panel's agent and so a different prompt. There is
 * no conversation, no tools and no room to explain itself: the answer is
 * going straight into a file between two lines of somebody's code, and
 * anything that is not code makes the file not compile.
 */

import { localize } from '../../../../nls.js';

export interface InlinePromptContext {
	readonly languageId: string;
	readonly path: string;
	/** The lines being replaced. Empty when writing at a bare cursor. */
	readonly selection: string;
	/** What sits above and below, so the answer fits its surroundings. */
	readonly before: string;
	readonly after: string;
	readonly instruction: string;
}

export function buildInlineSystemPrompt(replacing: boolean): string {
	const lines = [
		`You are editing one piece of a file, inside the person's editor, on their machine.`,
		``,
		`Answer with code and nothing else. No explanation, no preamble, no code fence, no "here is". What you write replaces the selected lines exactly as it arrives, so a single stray sentence breaks the file.`,
		``,
		`Match what is around it. The same indentation — the code you are given keeps its original leading whitespace, and yours must too. The same quote style, the same naming, the same way this file already does things. You are writing in somebody else's file, not starting one.`,
		``,
		`Change what was asked and leave the rest alone. Lines inside the selection that the instruction does not touch come back unchanged. Do not tidy, do not rename things you were not asked to rename, do not add comments explaining what you did.`,
		``,
		`If the instruction cannot be done with the code you were given, write the code unchanged and nothing else. Saying so would end up in the file.`,
	];

	if (!replacing) {
		lines.push(
			``,
			`Nothing is selected here. Write what was asked at this point, indented to match the surrounding lines, and write only that — the lines around it already exist and must not be repeated.`,
		);
	}

	return lines.join('\n');
}

export function buildInlineRequest(context: InlinePromptContext): string {
	const parts: string[] = [
		localize('cloudeide.inline.file', "File: {0} ({1})", context.path, context.languageId),
	];

	if (context.before.trim()) {
		parts.push('', localize('cloudeide.inline.above', "The lines above:"), context.before);
	}
	parts.push('', context.selection
		? localize('cloudeide.inline.replacing', "Replace these lines:")
		: localize('cloudeide.inline.writing', "Write at this point:"));
	if (context.selection) {
		parts.push(context.selection);
	}
	if (context.after.trim()) {
		parts.push('', localize('cloudeide.inline.below', "The lines below:"), context.after);
	}

	parts.push('', localize('cloudeide.inline.asked', "What to do:"), context.instruction);
	return parts.join('\n');
}

/**
 * Takes the fence off, when the model puts one on anyway.
 *
 * It is told not to, and mostly does not. "Mostly" is not good enough for
 * text that goes into a file without anybody reading it first: three
 * backticks at the top of a function is a syntax error, and the person would
 * be left wondering what the agent did to their file.
 */
export function stripFence(text: string): string {
	const trimmed = text.replace(/^\n+/, '').replace(/\s+$/, '');
	const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/;
	const found = trimmed.match(fence);
	return found ? found[1] : trimmed;
}
