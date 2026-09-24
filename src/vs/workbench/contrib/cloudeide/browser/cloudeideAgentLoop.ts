/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The loop.
 *
 * Ask the model, and when it asks for a tool, run the tool and ask again with
 * the answer. That is the whole of it — the part people imagine is secret is
 * about two hundred lines, and what makes one agent better than another is
 * the tools it is given and what it is told, not this.
 *
 * It talks to `POST /api/anthropic/v1/messages` on CloudeIDE's own server,
 * which forwards to the provider and charges the account for what came back.
 * So the model runs on our bill and the tools run on the person's machine —
 * which is the split the product is: local reach, billed centrally, and no
 * API key for anybody to paste.
 *
 * Nothing here knows what a file is. Tools arrive as an interface, so this can
 * be tested against a scripted conversation and a fake tool set, with no
 * network and no disk.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { AgentToolResult, AgentToolSchema } from './cloudeideAgentTools.js';

/** What the loop needs from a tool set. `CloudeideAgentTools` satisfies it. */
export interface IAgentToolHost {
	run(name: string, input: Record<string, unknown>, token: CancellationToken): Promise<AgentToolResult>;
}

export type AgentLoopEvent =
	/** A piece of the model's prose, as it arrives. */
	| { readonly type: 'text'; readonly text: string }
	/** The model has asked for a tool and the input is complete. */
	| { readonly type: 'toolStart'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
	| { readonly type: 'toolEnd'; readonly id: string; readonly name: string; readonly result: AgentToolResult }
	/** A new turn of the loop is starting. `step` counts from 1. */
	| { readonly type: 'step'; readonly step: number }
	| { readonly type: 'done'; readonly reason: 'finished' | 'stepLimit' | 'cancelled' };

/** An Anthropic content block, in the shapes this loop produces or reads. */
type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface Message {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

export interface AgentLoopOptions {
	/** The conversation so far. The newest user message is the last entry. */
	readonly messages: readonly Message[];
	readonly tools: readonly AgentToolSchema[];
	readonly toolHost: IAgentToolHost;
	readonly model: string;
	readonly system: string;
	/**
	 * POSTs the body to the messages endpoint and answers with the streaming
	 * response. Supplied by the caller so this module owes nothing to the
	 * client, the token, or the server's address.
	 */
	readonly send: (body: unknown) => Promise<Response>;
	readonly onEvent: (event: AgentLoopEvent) => void;
	readonly token: CancellationToken;
	/** Defaults to 24. A run that has not finished by then is stuck. */
	readonly maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 24;
const MAX_OUTPUT_TOKENS = 8192;

/*
 * How much conversation is allowed to travel, in characters.
 *
 * The message list only ever grew. Twenty-four steps, each able to carry a
 * quarter-megabyte file read, and the request eventually went past what the
 * model will accept — which the person saw as a raw provider error, at the
 * end of a run that had been going for minutes, with no hint that reading one
 * large file was what did it.
 *
 * Characters rather than tokens because counting tokens properly means
 * shipping a tokenizer for every model this can run on, and being roughly
 * right early is worth more here than being exactly right late. Four
 * characters to a token is the usual rule of thumb, so this is on the order
 * of ninety thousand tokens: comfortable inside every model in the list,
 * including the small ones, with the reply and the system prompt still to
 * come.
 */
const MAX_CONVERSATION_CHARS = 360_000;

/** What an elided tool result says in place of what it held. */
const DROPPED = '(This output was dropped to stay inside the context window. Read it again if you still need it.)';

/**
 * Sheds the oldest tool output until the conversation fits.
 *
 * Only `tool_result` content is touched, and only its text: the `tool_use`
 * block that asked for it stays exactly where it was, because the provider
 * rejects a conversation where a result has no matching call. What the model
 * loses is the contents of a file it read twenty steps ago, which it can
 * read again — and it is told so, rather than being left to wonder why its
 * memory of that file has holes in it.
 *
 * The newest two messages are never touched. Those are the turn that just
 * happened, and shedding them would take away the thing the next request is
 * a reply to.
 */
function trimToBudget(messages: Message[]): void {
	const size = () => messages.reduce((n, m) => n + weigh(m.content), 0);
	if (size() <= MAX_CONVERSATION_CHARS) {
		return;
	}

	for (let i = 0; i < messages.length - 2 && size() > MAX_CONVERSATION_CHARS; i++) {
		const content = messages[i].content;
		if (typeof content === 'string') {
			continue;
		}
		messages[i] = {
			role: messages[i].role,
			content: content.map(block => block.type === 'tool_result' && block.content !== DROPPED
				? { ...block, content: DROPPED }
				: block),
		};
	}
}

function weigh(content: Message['content']): number {
	if (typeof content === 'string') {
		return content.length;
	}
	return content.reduce((n, block) => {
		if (block.type === 'text') {
			return n + block.text.length;
		}
		if (block.type === 'tool_result') {
			return n + block.content.length;
		}
		if (block.type === 'tool_use') {
			return n + JSON.stringify(block.input ?? {}).length + block.name.length;
		}
		return n;
	}, 0);
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
	const messages: Message[] = options.messages.map(m => ({ role: m.role, content: m.content }));
	const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

	for (let step = 1; step <= maxSteps; step++) {
		if (options.token.isCancellationRequested) {
			options.onEvent({ type: 'done', reason: 'cancelled' });
			return;
		}
		options.onEvent({ type: 'step', step });

		const turn = await streamTurn(options, messages);
		if (options.token.isCancellationRequested) {
			options.onEvent({ type: 'done', reason: 'cancelled' });
			return;
		}

		// The assistant's turn goes back verbatim, tool calls and all. The
		// provider requires the tool_use block it sent to be present in the
		// history that carries its result.
		messages.push({ role: 'assistant', content: turn.content });

		const calls = turn.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
		if (calls.length === 0) {
			options.onEvent({ type: 'done', reason: 'finished' });
			return;
		}

		// Every tool the model asked for in this turn, answered in one user
		// message. Splitting them across messages is not what the API expects
		// and costs a round trip each.
		const results: ContentBlock[] = [];
		for (const call of calls) {
			options.onEvent({ type: 'toolStart', id: call.id, name: call.name, input: call.input });
			const result = await options.toolHost.run(call.name, call.input, options.token);
			options.onEvent({ type: 'toolEnd', id: call.id, name: call.name, result });
			results.push({
				type: 'tool_result',
				tool_use_id: call.id,
				content: result.content,
				...(result.isError ? { is_error: true } : {}),
			});
		}
		messages.push({ role: 'user', content: results });

		// After the results, not before: the turn that just happened is the
		// one most worth keeping whole, and it is the oldest output that goes.
		trimToBudget(messages);
	}

	options.onEvent({ type: 'done', reason: 'stepLimit' });
}

interface TurnResult {
	readonly content: ContentBlock[];
}

/**
 * One request, streamed, assembled into content blocks.
 *
 * Text is emitted as it arrives so the panel can show it being written. Tool
 * inputs are not: they stream as fragments of JSON that are not valid until
 * the last one, so they are buffered and parsed at `content_block_stop`.
 */
async function streamTurn(options: AgentLoopOptions, messages: readonly Message[]): Promise<TurnResult> {
	const response = await options.send({
		model: options.model,
		max_tokens: MAX_OUTPUT_TOKENS,
		system: options.system,
		// A copy, not the loop's own array. The loop goes on appending to that
		// one, so a caller holding this body — to retry it, to queue it, to
		// look at it in a test — would be holding a view of a later state
		// rather than of the request that was made.
		messages: messages.map(m => ({ role: m.role, content: m.content })),
		tools: options.tools,
		stream: true,
	});

	const body = response.body;
	if (!body) {
		throw new Error('The server sent an empty reply.');
	}

	const blocks: ContentBlock[] = [];
	/** Partial JSON for the tool_use block at each index, while it streams. */
	const partialInput = new Map<number, string>();

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (options.token.isCancellationRequested) {
				await reader.cancel().catch(() => { /* already gone */ });
				break;
			}
			buffered += decoder.decode(value, { stream: true });

			// Server-sent events are separated by a blank line, and a chunk can
			// split one in half, so whatever follows the last separator waits.
			const frames = buffered.split('\n\n');
			buffered = frames.pop() ?? '';

			for (const frame of frames) {
				const line = frame.split('\n').find(l => l.startsWith('data:'));
				if (!line) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') {
					continue;
				}
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(payload) as Record<string, unknown>;
				} catch {
					continue; // A frame that will not parse is not worth failing a run over.
				}
				handleEvent(event, blocks, partialInput, options.onEvent);
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { content: blocks };
}

function handleEvent(
	event: Record<string, unknown>,
	blocks: ContentBlock[],
	partialInput: Map<number, string>,
	emit: (event: AgentLoopEvent) => void,
): void {
	const index = typeof event.index === 'number' ? event.index : -1;

	switch (event.type) {
		case 'content_block_start': {
			const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
			if (block?.type === 'text') {
				blocks[index] = { type: 'text', text: '' };
			} else if (block?.type === 'tool_use') {
				blocks[index] = { type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: {} };
				partialInput.set(index, '');
			}
			return;
		}
		case 'content_block_delta': {
			const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
			if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
				const block = blocks[index];
				if (block?.type === 'text') {
					block.text += delta.text;
				}
				emit({ type: 'text', text: delta.text });
			} else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
				partialInput.set(index, (partialInput.get(index) ?? '') + delta.partial_json);
			}
			return;
		}
		case 'content_block_stop': {
			const block = blocks[index];
			if (block?.type === 'tool_use') {
				const raw = partialInput.get(index) ?? '';
				partialInput.delete(index);
				try {
					// An empty-input tool streams no delta at all, and `JSON.parse('')`
					// throws — so nothing is not an error, it is `{}`.
					block.input = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
				} catch {
					// Left empty rather than dropped: the tool reports what it
					// needs, which the model can act on. A missing tool_result
					// for a tool_use the provider sent is a protocol error.
					block.input = {};
				}
			}
			return;
		}
		default:
			return;
	}
}
