/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CloudeideAgentTools } from '../../browser/cloudeideAgentTools.js';
import type { CommandRunResult, IAgentCommandRunner } from '../../browser/cloudeideAgentCommand.js';

/**
 * `run_command` is the one tool that can do harm, and the thing that decides
 * whether it does is not the terminal — it is what the model is told
 * afterwards. An agent told "that failed" retries. An agent told "the person
 * said no" stops. These tests hold that line, and they need no terminal, no
 * shell and no disk to do it.
 *
 * The other constructor arguments are never reached on this path, so they are
 * left undefined rather than mocked. If that ever stops being true a test
 * here will throw on the first call, which is the failure we would want.
 */
function toolsWith(runner: IAgentCommandRunner | undefined): CloudeideAgentTools {
	const unused = undefined as never;
	return new CloudeideAgentTools(unused, unused, unused, unused, unused, unused, unused, runner);
}

function answering(result: CommandRunResult, seen?: string[]): IAgentCommandRunner {
	return {
		run: async (command: string) => {
			seen?.push(command);
			return result;
		},
	};
}

suite('CloudeIDE agent tools — run_command', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a refusal is an answer, not a failure', async () => {
		const tools = toolsWith(answering({ output: '', refused: true }));

		const result = await tools.run('run_command', { command: 'rm -rf /' }, CancellationToken.None);

		// isError is what makes the model treat something as a problem to
		// work around. A person saying no is not a problem to work around.
		assert.strictEqual(result.isError, undefined);
		assert.ok(/did not allow/i.test(result.content), result.content);
		assert.ok(/not ask for it again/i.test(result.content), result.content);
	});

	test('a command that succeeds reports its output and nothing else', async () => {
		const tools = toolsWith(answering({ output: '  12 tests passed\n', exitCode: 0 }));

		const result = await tools.run('run_command', { command: 'npm test' }, CancellationToken.None);

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(result.content, '12 tests passed');
	});

	test('a command that fails reports the code as well as the output', async () => {
		const tools = toolsWith(answering({ output: 'error TS2304', exitCode: 2 }));

		const result = await tools.run('run_command', { command: 'tsc' }, CancellationToken.None);

		assert.strictEqual(result.isError, true);
		assert.ok(result.content.includes('Exited 2'), result.content);
		assert.ok(result.content.includes('error TS2304'), result.content);
	});

	test('no exit code is said out loud rather than read as success', async () => {
		const tools = toolsWith(answering({ output: 'built' }));

		const result = await tools.run('run_command', { command: 'make' }, CancellationToken.None);

		assert.strictEqual(result.isError, undefined);
		assert.ok(/does not report exit codes/i.test(result.content), result.content);
	});

	test('a command that produced nothing says so rather than answering blank', async () => {
		const tools = toolsWith(answering({ output: '', exitCode: 0 }));

		const result = await tools.run('run_command', { command: 'touch a' }, CancellationToken.None);

		assert.strictEqual(result.content, '(no output)');
	});

	test('an empty command is refused before it reaches the runner', async () => {
		const seen: string[] = [];
		const tools = toolsWith(answering({ output: '', exitCode: 0 }, seen));

		const result = await tools.run('run_command', { command: '   ' }, CancellationToken.None);

		assert.strictEqual(result.isError, true);
		assert.deepStrictEqual(seen, []);
	});

	test('the tool is not offered where nothing can run one', () => {
		const names = toolsWith(undefined).schemas().map(tool => tool.name);

		assert.ok(!names.includes('run_command'));
		// The rest are still there: this filters one tool, not the list.
		assert.ok(names.includes('read_file'));
		assert.ok(names.includes('find_references'));
	});

	test('and it is offered where something can', () => {
		const names = toolsWith(answering({ output: '', exitCode: 0 })).schemas().map(tool => tool.name);

		assert.ok(names.includes('run_command'));
	});
});
