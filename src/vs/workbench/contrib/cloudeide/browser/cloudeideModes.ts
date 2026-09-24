/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Three ways to ask, and what each one is allowed to do.
 *
 * The agent had one gear. Every question — "what does this function do",
 * "how would you restructure this", "rename it everywhere" — went to a thing
 * that reads files, writes files and runs commands, and the only way to stop
 * it changing something was to not ask.
 *
 * That is fine for the change and wrong for the other two. Somebody asking
 * how a module works does not want four files edited; somebody weighing a
 * refactor wants to see the steps before any of them happen, while the plan
 * is still cheap to argue with.
 *
 * So the mode decides which tools exist for that turn. Not a line in the
 * prompt asking the model to restrain itself — the tools are not offered at
 * all, which is the difference between a rule and a fence.
 */

import { localize } from '../../../../nls.js';

export type AgentMode = 'agent' | 'plan' | 'ask';

export interface AgentModeInfo {
	readonly id: AgentMode;
	readonly label: string;
	readonly detail: string;
}

export const AGENT_MODES: readonly AgentModeInfo[] = [
	{
		id: 'agent',
		label: localize('cloudeide.mode.agent', "Agent"),
		detail: localize('cloudeide.mode.agentDetail', "Reads, changes files and runs commands. The default."),
	},
	{
		id: 'plan',
		label: localize('cloudeide.mode.plan', "Plan"),
		detail: localize('cloudeide.mode.planDetail', "Works out the steps and changes nothing. You press Build it."),
	},
	{
		id: 'ask',
		label: localize('cloudeide.mode.ask', "Ask"),
		detail: localize('cloudeide.mode.askDetail', "Answers questions about the project. Reads only."),
	},
];

/** Tools that change something, as opposed to finding something out. */
const WRITING = new Set(['edit_file', 'write_file']);

/** Tools that reach outside the editor. */
const RUNNING = new Set(['run_command']);

/**
 * Which tools a mode is given.
 *
 * `ask` and `plan` both come down to "may not change anything", and they
 * differ in what they are for rather than in what they can reach: plan is
 * expected to end with a list of steps, ask with an answer. Plan keeps
 * `ask_user`, because working out an approach is exactly when a fork is
 * worth raising; ask does not, because a question answered with a question
 * is not an answer.
 */
export function toolsForMode(mode: AgentMode, names: readonly string[]): string[] {
	if (mode === 'agent') {
		return [...names];
	}
	return names.filter(name => {
		if (WRITING.has(name) || RUNNING.has(name)) {
			return false;
		}
		if (mode === 'ask' && name === 'ask_user') {
			return false;
		}
		return true;
	});
}

/**
 * What the mode adds to the prompt.
 *
 * The fence does the enforcing; this says why the fence is there. A model
 * that finds `edit_file` missing and is told nothing will spend a turn
 * trying to write a file through `run_command`, or apologise for being
 * unable to help — both worse than being told plainly that this turn is for
 * thinking.
 */
export function modeInstructions(mode: AgentMode): readonly string[] {
	switch (mode) {
		case 'plan':
			return [
				`## This turn is for planning`,
				``,
				`You cannot change a file or run a command right now — those tools are not available to you, and that is deliberate. Read whatever you need, then say what you would do.`,
				``,
				`Answer with numbered steps, in the order you would do them. Each step names the file it touches and says what changes there, in one line. Where you had to choose between two approaches, say which you took and what the other one was — that is the part worth arguing with while it is still free.`,
				``,
				`Say plainly what you are unsure about. A plan that hides its weak step is worse than one that names it.`,
				``,
				`Do not end by asking whether to go ahead. The person has a button for that.`,
			];
		case 'ask':
			return [
				`## This turn is a question, not a job`,
				``,
				`You cannot change a file or run a command right now, and you are not being asked to. Read what you need and answer.`,
				``,
				`Answer the question that was asked, at the length it deserves — one line if one line does it. Point at the code: name the file and the line rather than describing it from memory.`,
				``,
				`If the answer is "that is not what this does", say so. If you would change something, say what and why in a sentence, and stop there.`,
			];
		default:
			return [];
	}
}

export function modeById(id: string | undefined): AgentMode {
	return AGENT_MODES.some(m => m.id === id) ? id as AgentMode : 'agent';
}
