/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Running a command, in a real terminal, on the person's own machine.
 *
 * This is the tool that makes the agent able to finish something rather than
 * only describe it: `npm test` says whether the change works, `tsc --noEmit`
 * says whether it compiles, `git diff` says what actually changed. Without
 * it the agent is guessing about its own work.
 *
 * It is also the one tool that can do damage. Reading a file cannot delete a
 * database; `rm -rf` can. So nothing in here runs without a person clicking
 * Run — that gate is the caller's, and the tool refuses to exist without one.
 *
 * The terminal is a visible terminal, not a hidden process. That is on
 * purpose: whatever the agent runs, the person can scroll back and read, and
 * can press Ctrl+C in it like any other. A command run somewhere invisible is
 * a command nobody can check.
 *
 * Almost none of the hard part is written here. VS Code already solved it for
 * its own agent — shell integration, command boundaries, exit codes, the
 * three fallbacks for shells that report less — and that code is in this
 * repository under `terminalContrib/chatAgentTools`. This is a small door
 * onto it.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { OperatingSystem, OS } from '../../../../base/common/platform.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ITerminalProfile } from '../../../../platform/terminal/common/terminal.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { ITerminalProfileResolverService } from '../../terminal/common/terminal.js';
import {
	BasicExecuteStrategy, NoneExecuteStrategy, RichExecuteStrategy, ShellIntegrationQuality, ToolTerminalCreator,
	type ITerminalExecuteStrategy, type IToolTerminal,
} from '../../terminal/terminalContribChatExports.js';

/** What the model is told after a command has run. */
export interface CommandRunResult {
	readonly output: string;
	readonly exitCode?: number;
	/** Set when the command could not be run at all, as opposed to failing. */
	readonly error?: string;
	/**
	 * The person was asked and said no.
	 *
	 * Kept apart from `error` on purpose: a refusal is an answer, not a
	 * fault, and an agent told its command "failed" will try it again.
	 */
	readonly refused?: boolean;
}

/**
 * The thing the tool calls. The panel implements it, because asking a person
 * for permission is a thing only the panel can do — which is also why the
 * tools file takes this as an argument rather than building a terminal
 * itself, and why it can still be tested with no terminal at all.
 */
export interface IAgentCommandRunner {
	run(command: string, token: CancellationToken): Promise<CommandRunResult>;
}

/** How much of a command's output the model is shown. */
const MAX_OUTPUT_CHARS = 16 * 1024;

export class CloudeideCommandRunner extends Disposable implements IAgentCommandRunner {

	/**
	 * One terminal for the whole window, not one per command.
	 *
	 * A new terminal per command would lose everything a shell carries
	 * between commands — the working directory a `cd` moved to, an activated
	 * virtualenv, an `export` — and the agent would be running each command
	 * in a world its previous command never touched. It would also stack a
	 * tab per call.
	 */
	private terminal: IToolTerminal | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
		@ITerminalProfileResolverService private readonly profileResolver: ITerminalProfileResolverService,
	) {
		super();
		this._register({
			dispose: () => {
				this.terminal?.instance.dispose();
				this.terminal = undefined;
			}
		});
	}

	async run(command: string, token: CancellationToken): Promise<CommandRunResult> {
		const store = new DisposableStore();
		try {
			const terminal = await this.ensureTerminal(token);
			if (token.isCancellationRequested) {
				return { output: '', error: 'Cancelled before the command ran.' };
			}

			// xterm has to be attached before a strategy can read anything off
			// the screen, and the rich and basic strategies both do.
			const xterm = await terminal.instance.xtermReadyPromise;
			if (!xterm) {
				return { output: '', error: 'The terminal closed before it was ready.' };
			}

			const strategy = store.add(this.strategyFor(terminal));
			const result = await strategy.execute(command, token);

			return {
				output: truncate(result.output ?? ''),
				exitCode: result.exitCode,
				error: result.error,
			};
		} catch (err) {
			return { output: '', error: err instanceof Error ? err.message : String(err) };
		} finally {
			store.dispose();
		}
	}

	/**
	 * How much the shell tells us, and what to do with each answer.
	 *
	 * Shell integration is what turns a stream of bytes into "this command
	 * started here, ended there, and exited 1". Where it is installed and
	 * reporting fully, `rich` reads all of that. Where it reports only
	 * boundaries, `basic` reads what it can. Where there is none — a shell
	 * nobody instrumented — `none` waits for the output to go quiet and
	 * hands back what it saw, with no exit code. All three are upstream's.
	 */
	private strategyFor(terminal: IToolTerminal): ITerminalExecuteStrategy {
		const commandDetection = terminal.instance.capabilities.get(TerminalCapability.CommandDetection);
		switch (terminal.shellIntegrationQuality) {
			case ShellIntegrationQuality.Rich:
				if (commandDetection) {
					return this.instantiationService.createInstance(RichExecuteStrategy, terminal.instance, commandDetection, true);
				}
				break;
			case ShellIntegrationQuality.Basic:
				if (commandDetection) {
					return this.instantiationService.createInstance(
						BasicExecuteStrategy, terminal.instance, () => terminal.receivedUserInput ?? false, commandDetection);
				}
				break;
		}
		return this.instantiationService.createInstance(
			NoneExecuteStrategy, terminal.instance, () => terminal.receivedUserInput ?? false);
	}

	private async ensureTerminal(token: CancellationToken): Promise<IToolTerminal> {
		// A terminal the person closed is gone, and reusing the handle gets a
		// disposed instance rather than an error that says so.
		if (this.terminal && !this.terminal.instance.isDisposed) {
			return this.terminal;
		}
		const os = (await this.remoteAgentService.getEnvironment())?.os ?? OS;
		const profile = await this.shell(os);
		const creator = this.instantiationService.createInstance(ToolTerminalCreator);
		this.terminal = await creator.createTerminal(profile, os, token);
		return this.terminal;
	}

	/**
	 * Which shell to open.
	 *
	 * The person's default, with two substitutions that upstream makes for
	 * the same reason: `cmd.exe` and `/bin/sh` have no shell integration at
	 * all, so a default that resolves to either would drop every command to
	 * the `none` strategy and lose exit codes for no reason. PowerShell and
	 * bash are on the machines those are the default on.
	 */
	private async shell(os: OperatingSystem): Promise<ITerminalProfile> {
		const profile = await this.profileResolver.getDefaultProfile({
			os,
			remoteAuthority: this.remoteAgentService.getConnection()?.remoteAuthority,
		});
		if (basename(profile.path) === 'cmd.exe') {
			return { ...profile, path: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', profileName: 'PowerShell', icon: undefined };
		}
		if (profile.path === '/bin/sh') {
			return { ...profile, path: '/bin/bash', profileName: 'bash', icon: undefined };
		}
		return { ...profile, icon: undefined };
	}
}

/**
 * Keep the end, not the beginning.
 *
 * A failing build prints its errors last. Cutting the tail off a 5,000-line
 * `npm test` leaves the model reading the dependency banner and guessing at
 * the failure it was run to find.
 */
function truncate(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) {
		return output;
	}
	const kept = output.slice(output.length - MAX_OUTPUT_CHARS);
	return `[earlier output cut; the last ${MAX_OUTPUT_CHARS} characters follow]\n${kept}`;
}
