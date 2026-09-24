/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `/` at the start of the box, for the things people ask for over and over.
 *
 * "Work out the steps first", "run the tests and fix what breaks", "read
 * this back and tell me what is wrong with it" — the same sentences, typed
 * again every time, each one slightly different and so each one landing
 * slightly differently. A word does it instead, and the word expands into a
 * sentence that was written once and is the same every time.
 *
 * They are shorthand, not a second way for the agent to behave. Each one
 * becomes ordinary text in the message, or flips the mode the composer
 * already has — nothing here reaches the model that the person could not
 * have typed themselves.
 */

import { localize } from '../../../../nls.js';
import type { AgentMode } from './cloudeideModes.js';

export interface SlashCommand {
	readonly name: string;
	readonly summary: string;
	/** Put in front of whatever else was typed. */
	readonly expands?: string;
	/** Switches the composer's mode for this turn. */
	readonly mode?: AgentMode;
	/** Handled by the panel rather than sent — `/undo` has nothing to say to a model. */
	readonly local?: 'undo' | 'pr' | 'clear';
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: 'plan',
		summary: localize('cloudeide.slash.plan', "work out the steps first, change nothing"),
		mode: 'plan',
	},
	{
		name: 'ask',
		summary: localize('cloudeide.slash.ask', "answer a question about the project, read only"),
		mode: 'ask',
	},
	{
		name: 'test',
		summary: localize('cloudeide.slash.test', "run the tests and fix what fails"),
		expands: localize('cloudeide.slash.testText',
			"Run this project's tests. If any fail, read the failures, fix the cause rather than the test, and run them again. Stop when they pass or when you are stuck, and say which."),
	},
	{
		name: 'review',
		summary: localize('cloudeide.slash.review', "read the last change back and say what is wrong with it"),
		expands: localize('cloudeide.slash.reviewText',
			"Read the change that was just made and review it as if somebody else had written it. Say what is wrong with it, what would break, and what you would do differently. Do not change anything — this is a reading, not a second attempt."),
	},
	{
		name: 'pr',
		summary: localize('cloudeide.slash.pr', "open a pull request for the last change"),
		local: 'pr',
	},
	{
		name: 'undo',
		summary: localize('cloudeide.slash.undo', "put the last change back"),
		local: 'undo',
	},
	{
		name: 'clear',
		summary: localize('cloudeide.slash.clear', "start a new conversation"),
		local: 'clear',
	},
];

/**
 * The command somebody is part-way through typing, if any.
 *
 * Only at the very start of the box. A `/` in the middle of a sentence is a
 * path, a date or a fraction, and offering a command list over any of those
 * would be the feature getting in the way of the thing it is meant to help.
 */
export function findSlash(text: string, caret: number): { query: string } | undefined {
	if (!text.startsWith('/')) {
		return undefined;
	}
	const firstSpace = text.indexOf(' ');
	const end = firstSpace === -1 ? text.length : firstSpace;
	if (caret > end) {
		return undefined;
	}
	return { query: text.slice(1, end) };
}

export function matchingCommands(query: string): SlashCommand[] {
	const needle = query.toLowerCase();
	return SLASH_COMMANDS.filter(c => c.name.startsWith(needle));
}

/**
 * Turns what was typed into what is sent.
 *
 * A command may carry the rest of the sentence with it — `/test the cart
 * ones` is a real thing to want — so the expansion goes in front rather than
 * replacing what follows it.
 */
export function applySlash(text: string): { text: string; mode?: AgentMode; local?: SlashCommand['local'] } {
	if (!text.startsWith('/')) {
		return { text };
	}
	const firstSpace = text.indexOf(' ');
	const name = (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();

	const found = SLASH_COMMANDS.find(c => c.name === name);
	if (!found) {
		// Not one of ours. Sent as typed, because `/` is a perfectly ordinary
		// way to start a sentence about a path and guessing at the nearest
		// command would answer a question nobody asked.
		return { text };
	}
	if (found.local) {
		return { text: rest, local: found.local };
	}
	const expanded = found.expands
		? (rest ? `${found.expands}\n\n${rest}` : found.expands)
		: rest;
	return { text: expanded, mode: found.mode };
}
