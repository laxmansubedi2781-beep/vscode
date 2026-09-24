/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runAgentLoop, type AgentLoopEvent, type IAgentToolHost } from '../../browser/cloudeideAgentLoop.js';
import type { AgentToolResult } from '../../browser/cloudeideAgentTools.js';

/**
 * A scripted conversation, so the loop can be tested without a network, a
 * model, a token or a disk — which is the reason it takes `send` and a tool
 * host as arguments rather than reaching for either itself.
 */

/** One server-sent event, framed the way the endpoint frames them. */
function frame(payload: object): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A streamed turn that says something and stops. */
function saying(text: string): string {
	return [
		frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
		frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
		frame({ type: 'content_block_stop', index: 0 }),
		frame({ type: 'message_stop' }),
	].join('');
}

/** A streamed turn that asks for one tool, with its input split mid-JSON. */
function calling(id: string, name: string, input: object): string {
	const json = JSON.stringify(input);
	const cut = Math.floor(json.length / 2);
	return [
		frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } }),
		frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } }),
		frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } }),
		frame({ type: 'content_block_stop', index: 0 }),
		frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
		frame({ type: 'message_stop' }),
	].join('');
}

/**
 * A response whose body arrives in small pieces that do not line up with the
 * event boundaries — which is how a real one arrives, and the case that
 * breaks a parser that assumes a chunk is a whole event.
 */
function streamed(body: string): Response {
	const bytes = new TextEncoder().encode(body);
	let at = 0;
	return {
		body: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (at >= bytes.length) {
					controller.close();
					return;
				}
				// Seven bytes at a time: small enough to split every event.
				controller.enqueue(bytes.slice(at, at + 7));
				at += 7;
			},
		}),
	} as Response;
}

suite('CloudeIDE agent loop', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const noTools: IAgentToolHost = { async run(): Promise<AgentToolResult> { return { content: '' }; } };

	async function run(turns: string[], toolHost = noTools, token = CancellationToken.None) {
		const events: AgentLoopEvent[] = [];
		const sent: unknown[] = [];
		let turn = 0;
		await runAgentLoop({
			messages: [{ role: 'user', content: 'go' }],
			tools: [],
			toolHost,
			model: 'claude-sonnet-5',
			system: 'be brief',
			send: async body => {
				sent.push(body);
				return streamed(turns[turn++] ?? saying('done'));
			},
			onEvent: e => events.push(e),
			token,
		});
		return { events, sent };
	}

	test('text arrives in pieces and the run finishes', async () => {
		const { events } = await run([saying('Hello there')]);
		const text = events.filter(e => e.type === 'text').map(e => e.text).join('');
		assert.strictEqual(text, 'Hello there');
		assert.deepStrictEqual(events.at(-1), { type: 'done', reason: 'finished' });
	});

	test('a tool call is run and its answer goes back in the next request', async () => {
		const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
		const toolHost: IAgentToolHost = {
			async run(name: string, input: Record<string, unknown>): Promise<AgentToolResult> {
				calls.push({ name, input });
				return { content: 'export const menu = []' };
			},
		};

		const { events, sent } = await run(
			[calling('tu_1', 'read_file', { path: 'src/menu.js' }), saying('It exports a menu.')],
			toolHost,
		);

		// The input was split across two deltas; it has to arrive whole.
		assert.deepStrictEqual(calls, [{ name: 'read_file', input: { path: 'src/menu.js' } }]);

		const second = sent[1] as { messages: Array<{ role: string; content: unknown }> };
		assert.strictEqual(second.messages.length, 3, 'the assistant turn and the tool result are both carried');
		assert.strictEqual(second.messages[1].role, 'assistant');
		assert.deepStrictEqual(second.messages[2], {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'export const menu = []' }],
		});

		assert.ok(events.some(e => e.type === 'toolStart' && e.name === 'read_file'));
		assert.ok(events.some(e => e.type === 'toolEnd' && e.name === 'read_file'));
		assert.deepStrictEqual(events.at(-1), { type: 'done', reason: 'finished' });
	});

	test('a failed tool is reported to the model rather than ending the run', async () => {
		const toolHost: IAgentToolHost = {
			async run(): Promise<AgentToolResult> {
				return { content: 'There is no file at nope.js.', isError: true };
			},
		};
		const { sent } = await run(
			[calling('tu_1', 'read_file', { path: 'nope.js' }), saying('I will look elsewhere.')],
			toolHost,
		);
		const second = sent[1] as { messages: Array<{ content: unknown }> };
		assert.deepStrictEqual(second.messages[2].content, [{
			type: 'tool_result',
			tool_use_id: 'tu_1',
			content: 'There is no file at nope.js.',
			is_error: true,
		}]);
	});

	test('a model that only ever asks for tools is stopped', async () => {
		const forever = Array.from({ length: 10 }, (_, i) => calling(`tu_${i}`, 'list_files', {}));
		const events: AgentLoopEvent[] = [];
		let turn = 0;
		await runAgentLoop({
			messages: [{ role: 'user', content: 'go' }],
			tools: [],
			toolHost: noTools,
			model: 'claude-sonnet-5',
			system: '',
			send: async () => streamed(forever[turn++] ?? forever[0]),
			onEvent: e => events.push(e),
			token: CancellationToken.None,
			maxSteps: 3,
		});
		assert.deepStrictEqual(events.at(-1), { type: 'done', reason: 'stepLimit' });
		assert.strictEqual(events.filter(e => e.type === 'step').length, 3);
	});

	test('cancelling stops the run', async () => {
		const source = new CancellationTokenSource();
		source.cancel();
		const { events } = await run([saying('never sent')], noTools, source.token);
		assert.deepStrictEqual(events, [{ type: 'done', reason: 'cancelled' }]);
		source.dispose();
	});

	/*
	 * The context budget.
	 *
	 * This is the failure that only shows up on a long run: the message list
	 * grows, nothing ever leaves it, and eventually the provider refuses the
	 * request — minutes in, as a raw error, with nothing saying that reading
	 * one large file is what did it.
	 */
	test('old tool output is shed once the conversation gets too big', async () => {
		// Each read answers with a third of the budget, so the third one has
		// to push the first one out.
		const huge = 'x'.repeat(130_000);
		const host: IAgentToolHost = { async run(): Promise<AgentToolResult> { return { content: huge }; } };

		const { sent } = await run([
			calling('a', 'read_file', { path: 'one' }),
			calling('b', 'read_file', { path: 'two' }),
			calling('c', 'read_file', { path: 'three' }),
			saying('done'),
		], host);

		const last = sent.at(-1) as { messages: { role: string; content: unknown }[] };
		const results = last.messages
			.flatMap(m => Array.isArray(m.content) ? m.content : [])
			.filter((b): b is { type: string; content: string } =>
				typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result');

		assert.strictEqual(results.length, 3, 'every call still has its result block');
		// The pairing is what the provider checks; dropping a whole message
		// would be rejected outright.
		assert.ok(results[0].content.length < 1000, 'the oldest output was shed');
		assert.ok(/dropped to stay inside the context window/i.test(results[0].content), results[0].content);
		assert.strictEqual(results.at(-1)!.content, huge, 'the newest output is kept whole');

		const total = JSON.stringify(last.messages).length;
		assert.ok(total < 400_000, `conversation still ${total} characters`);
	});

	test('a conversation under the budget is left exactly as it was', async () => {
		const host: IAgentToolHost = { async run(): Promise<AgentToolResult> { return { content: 'small' }; } };

		const { sent } = await run([
			calling('a', 'read_file', { path: 'one' }),
			calling('b', 'read_file', { path: 'two' }),
			saying('done'),
		], host);

		const last = sent.at(-1) as { messages: { content: unknown }[] };
		const results = last.messages
			.flatMap(m => Array.isArray(m.content) ? m.content : [])
			.filter((b): b is { type: string; content: string } =>
				typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result');

		assert.deepStrictEqual(results.map(r => r.content), ['small', 'small']);
	});

	test('a tool asked for with no input gets an empty object, not a crash', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const toolHost: IAgentToolHost = {
			async run(_name: string, input: Record<string, unknown>): Promise<AgentToolResult> {
				calls.push(input);
				return { content: 'index.html' };
			},
		};
		// `content_block_start` then straight to `stop`: no delta at all, which
		// is what an argument-less tool actually streams.
		const turn = [
			frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'list_files' } }),
			frame({ type: 'content_block_stop', index: 0 }),
			frame({ type: 'message_stop' }),
		].join('');
		await run([turn, saying('one file')], toolHost);
		assert.deepStrictEqual(calls, [{}]);
	});
});
