/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the agent can do to the folder you have open.
 *
 * These run here, in the application, against the real file system — which is
 * the whole reason they exist. The server's agent has tools of the same names,
 * but they read a copy of the project uploaded before each run: never more
 * than the panel could collect, never `node_modules` or `.git`, and never the
 * file you saved a second ago. These read the disk.
 *
 * Nothing in here talks to a model. A tool is a name, a schema the model is
 * shown, and a function that answers it — so the loop can be tested with a
 * scripted conversation, and these can be tested with no conversation at all.
 *
 * Every path the model sends is workspace-relative and is resolved through
 * `resolvePath`, which refuses anything that climbs out of the folder. The
 * model is not the attacker here; a confused path is the likelier accident,
 * and either way writing outside the project is not a thing this should be
 * able to do.
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { getWorkspaceSymbols } from '../../search/common/search.js';
import type { IAgentCommandRunner } from './cloudeideAgentCommand.js';
import { symbolKindNames } from '../../../../editor/common/languages.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { getReferencesAtPosition } from '../../../../editor/contrib/gotoSymbol/browser/goToSymbol.js';

/** A tool as the model is shown it. Anthropic's tool-use shape. */
export interface AgentToolSchema {
	readonly name: string;
	readonly description: string;
	readonly input_schema: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

export interface AgentToolResult {
	readonly content: string;
	readonly isError?: boolean;
}

/**
 * A change the agent wants to make, held rather than applied.
 *
 * Writes do not touch the disk when the model asks for them. They are staged,
 * the panel shows the diff, and a person presses Apply. The model is told the
 * edit is staged — truthfully — so it can carry on planning without being
 * told something that has not happened.
 */
export interface StagedEdit {
	readonly path: string;
	/** Undefined for a file that does not exist yet. */
	readonly before: string | undefined;
	readonly after: string;
}

/** How many bytes of one file the model is shown before it is truncated. */
const MAX_FILE_BYTES = 256 * 1024;
/** How many paths `list_files` will name. */
const MAX_LISTED = 400;
/** How many matches `search_files` will report. */
const MAX_MATCHES = 80;
/** How many errors or warnings `get_diagnostics` will report. */
const MAX_MARKERS = 60;
/** How many declarations `find_symbol` will report. */
const MAX_SYMBOLS = 40;
/** How many uses `find_references` will report. */
const MAX_REFERENCES = 60;

const SKIP_DIRS = new Set([
	'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
	'.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target',
]);

export const AGENT_TOOLS: readonly AgentToolSchema[] = [
	{
		name: 'list_files',
		description:
			'List the files in the open project, as paths relative to its root. ' +
			'Start here when you do not already know what the project contains. ' +
			'Build output and dependency folders are left out.',
		input_schema: {
			type: 'object',
			properties: {
				subdirectory: {
					type: 'string',
					description: 'Limit the listing to this folder, relative to the project root. Omit for the whole project.',
				},
			},
		},
	},
	{
		name: 'read_file',
		description:
			'Read one file. Use a path exactly as list_files or search_files reported it. ' +
			'Read before you edit: edit_file needs text that is actually in the file.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the project root.' },
			},
			required: ['path'],
		},
	},
	{
		name: 'search_files',
		description:
			'Search the project for a string or regular expression and report the matching lines with their paths. ' +
			'Faster and more reliable than reading files one by one to find something.',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'What to search for.' },
				isRegex: { type: 'boolean', description: 'Treat the query as a regular expression. Default false.' },
				include: { type: 'string', description: 'Optional glob to limit the search, e.g. "src/**/*.ts".' },
			},
			required: ['query'],
		},
	},
	{
		name: 'edit_file',
		description:
			'Replace an exact piece of text in a file. `find` must appear in the file exactly once — ' +
			'include enough surrounding lines to make it unique. The change is staged for the ' +
			'person to approve, not written immediately.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the project root.' },
				find: { type: 'string', description: 'The exact text to replace, as it appears in the file.' },
				replace: { type: 'string', description: 'What to put in its place.' },
			},
			required: ['path', 'find', 'replace'],
		},
	},
	{
		name: 'find_symbol',
		description:
			'Find where a function, class, type or variable is declared, by name, anywhere in the ' +
			'project. This asks the language server rather than the text, so it finds the ' +
			'declaration itself and not every line that mentions the word — use it instead of ' +
			'search_files when you want the definition of something.',
		input_schema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The symbol name, or part of it.' },
			},
			required: ['name'],
		},
	},
	{
		name: 'find_references',
		description:
			'Find everywhere a function, class or variable is actually used — every call site, ' +
			'every import, every mention the language server considers the same thing. Use this ' +
			'before you change a signature or rename something, to see what you are about to ' +
			'break. This is not a text search: it will not match a different function that ' +
			'happens to share the name, and it will follow a renamed import.',
		input_schema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The symbol name, exactly as it is declared.' },
				path: {
					type: 'string',
					description:
						'If more than one thing has this name, the file its declaration is in, ' +
						'relative to the project root. Omit unless find_symbol showed you several.',
				},
			},
			required: ['name'],
		},
	},
	{
		name: 'get_diagnostics',
		description:
			'Read the errors and warnings the editor itself is reporting — type errors, lint, ' +
			'anything a language server found. Use this to see what is already broken before you ' +
			'change something, and after a change is applied to see whether you fixed it or broke ' +
			'something else. It reports what is on disk: an edit you have staged but the person ' +
			'has not applied yet is not in here.',
		input_schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Only this file, relative to the project root. Omit for the whole project.',
				},
				includeWarnings: {
					type: 'boolean',
					description: 'Include warnings as well as errors. Default false — errors only.',
				},
			},
		},
	},
	{
		name: 'write_file',
		description:
			'Write a whole file, creating it if it does not exist. Use edit_file for a change to an ' +
			'existing file; this replaces everything in it. The change is staged for the person to ' +
			'approve, not written immediately.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to the project root.' },
				content: { type: 'string', description: 'The complete new contents of the file.' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'run_command',
		description:
			'Run a shell command in the project folder and read what it printed. Use it to check ' +
			'your own work — run the tests, the type checker, the build, `git diff` — rather than ' +
			'assuming a change is right. It runs in a terminal the person can see and stop.\n\n' +
			'The person is asked before every command and can refuse. Ask for one command at a ' +
			'time, and say in your message why you want to run it. Do not use it to read or ' +
			'change files: read_file, edit_file and write_file are for that, and they do not need ' +
			'anyone\'s permission.',
		input_schema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command line, exactly as it would be typed.' },
				why: {
					type: 'string',
					description: 'One short line the person will read, saying what this is for. Example: "to see whether the tests pass".',
				},
			},
			required: ['command'],
		},
	},
];

export class CloudeideAgentTools {

	/** Staged writes, by path. The last one for a path wins, as it would on disk. */
	private readonly staged = new Map<string, StagedEdit>();

	constructor(
		private readonly fileService: IFileService,
		private readonly contextService: IWorkspaceContextService,
		private readonly searchService: ISearchService,
		private readonly queryBuilder: QueryBuilder,
		private readonly markerService: IMarkerService,
		private readonly languageFeaturesService: ILanguageFeaturesService,
		private readonly textModelService: ITextModelService,
		/**
		 * Undefined where nothing can run a command — the tests, and the web
		 * build, which has no terminal. `run_command` is then not offered at
		 * all rather than offered and always failing.
		 */
		private readonly commandRunner: IAgentCommandRunner | undefined,
	) { }

	/**
	 * The tools to show the model on this machine.
	 *
	 * A tool the model can see is a tool it will try. Offering `run_command`
	 * where nothing can run one buys a turn spent on a call that was never
	 * going to work, so it is left out instead.
	 */
	schemas(): readonly AgentToolSchema[] {
		return this.commandRunner
			? AGENT_TOOLS
			: AGENT_TOOLS.filter(tool => tool.name !== 'run_command');
	}

	edits(): readonly StagedEdit[] {
		return [...this.staged.values()];
	}

	clearEdits(): void {
		this.staged.clear();
	}

	async run(name: string, input: Record<string, unknown>, token: CancellationToken): Promise<AgentToolResult> {
		try {
			switch (name) {
				case 'list_files': return await this.listFiles(input, token);
				case 'read_file': return await this.readFile(input);
				case 'search_files': return await this.searchFiles(input, token);
				case 'get_diagnostics': return this.diagnostics(input);
				case 'find_symbol': return await this.findSymbol(input, token);
				case 'find_references': return await this.findReferences(input, token);
				case 'edit_file': return await this.editFile(input);
				case 'write_file': return await this.writeFile(input);
				case 'run_command': return await this.runCommand(input, token);
				default: return { content: `There is no tool called ${name}.`, isError: true };
			}
		} catch (err) {
			// The model can recover from a failed tool call if it is told what
			// went wrong, and cannot if the run dies instead.
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	/** The one folder the agent may touch. */
	private root(): URI {
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error('No folder is open. Open the project you want to work on first.');
		}
		return folders[0].uri;
	}

	/**
	 * A workspace-relative path, resolved and checked.
	 *
	 * Checked on the resolved result rather than by looking for `..` in the
	 * input: `a/../../b` contains no leading `..` and still leaves the folder,
	 * and a path that reaches the same place by symlink would pass a textual
	 * test too. What matters is where it lands.
	 */
	private resolvePath(raw: unknown): { uri: URI; relative: string } {
		if (typeof raw !== 'string' || raw.trim().length === 0) {
			throw new Error('A path is required.');
		}
		const relative = raw.replace(/^[./\\]+/, '').replace(/\\/g, '/');
		const root = this.root();
		const uri = URI.joinPath(root, relative);
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
		if (uri.scheme !== root.scheme || !uri.path.startsWith(rootPath)) {
			throw new Error(`${raw} is outside the open project.`);
		}
		return { uri, relative };
	}

	private async listFiles(input: Record<string, unknown>, token: CancellationToken): Promise<AgentToolResult> {
		const root = this.root();
		const start = typeof input.subdirectory === 'string' && input.subdirectory.trim()
			? this.resolvePath(input.subdirectory).uri
			: root;

		const paths: string[] = [];
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;

		const walk = async (dir: URI): Promise<void> => {
			if (paths.length >= MAX_LISTED || token.isCancellationRequested) {
				return;
			}
			const stat = await this.fileService.resolve(dir);
			for (const child of stat.children ?? []) {
				if (paths.length >= MAX_LISTED) {
					return;
				}
				const name = child.name;
				if (child.isDirectory) {
					// Dot-folders and build output are noise the model would
					// otherwise spend its context reading.
					if (SKIP_DIRS.has(name) || name.startsWith('.')) {
						continue;
					}
					await walk(child.resource);
				} else {
					paths.push(child.resource.path.slice(rootPath.length));
				}
			}
		};

		await walk(start);
		paths.sort();
		if (paths.length === 0) {
			return { content: 'The project has no files in it yet.' };
		}
		const capped = paths.length >= MAX_LISTED
			? `\n\n(${MAX_LISTED} shown; there are more. Use search_files to find something specific.)`
			: '';
		return { content: paths.join('\n') + capped };
	}

	private async readFile(input: Record<string, unknown>): Promise<AgentToolResult> {
		const { uri, relative } = this.resolvePath(input.path);
		const exists = await this.fileService.exists(uri);
		if (!exists) {
			return { content: `There is no file at ${relative}.`, isError: true };
		}
		const content = await this.fileService.readFile(uri);
		if (content.value.byteLength > MAX_FILE_BYTES) {
			const head = content.value.slice(0, MAX_FILE_BYTES).toString();
			return {
				content: `${head}\n\n(${relative} is ${content.value.byteLength} bytes; the first ${MAX_FILE_BYTES} are shown.)`,
			};
		}
		return { content: content.value.toString() };
	}

	private async searchFiles(input: Record<string, unknown>, token: CancellationToken): Promise<AgentToolResult> {
		const query = typeof input.query === 'string' ? input.query : '';
		if (!query.trim()) {
			return { content: 'A query is required.', isError: true };
		}
		const root = this.root();
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;

		const textQuery = this.queryBuilder.text(
			{ pattern: query, isRegExp: input.isRegex === true },
			[root],
			{
				maxResults: MAX_MATCHES,
				includePattern: typeof input.include === 'string' && input.include.trim()
					? input.include.trim()
					: undefined,
				// The same folders `list_files` hides, for the same reason.
				excludePattern: [{ pattern: [...SKIP_DIRS].map(d => `**/${d}/**`) }],
			},
		);

		const result = await this.searchService.textSearch(textQuery, token);
		const lines: string[] = [];
		for (const fileMatch of result.results) {
			const path = fileMatch.resource.path.startsWith(rootPath)
				? fileMatch.resource.path.slice(rootPath.length)
				: fileMatch.resource.path;
			for (const match of fileMatch.results ?? []) {
				if (lines.length >= MAX_MATCHES) {
					break;
				}
				// Text matches carry their line; the shape differs between
				// text and cell matches, so anything without one is skipped
				// rather than reported at a line number that is a guess.
				const preview = 'previewText' in match ? match.previewText : undefined;
				if (typeof preview !== 'string') {
					continue;
				}
				lines.push(`${path}: ${preview.split('\n')[0].trim()}`);
			}
		}

		if (lines.length === 0) {
			return { content: `Nothing in the project matches ${query}.` };
		}
		const capped = result.limitHit ? `\n\n(${lines.length} shown; there are more.)` : '';
		return { content: lines.join('\n') + capped };
	}

	/**
	 * Where something is declared, according to the language server.
	 *
	 * `search_files` finds every line that contains a word. This finds the
	 * declaration — the function, the class, the type — because it asks the
	 * thing that has already parsed the project rather than the text. For
	 * "where does `total` come from", the difference is one answer against
	 * forty.
	 *
	 * Providers come from whatever extensions are installed, so a project in a
	 * language nobody has an extension for gets nothing back. That is worth
	 * saying rather than hiding: the answer is "nothing found", and the agent
	 * can fall back to searching.
	 */
	private async findSymbol(input: Record<string, unknown>, token: CancellationToken): Promise<AgentToolResult> {
		const name = typeof input.name === 'string' ? input.name.trim() : '';
		if (!name) {
			return { content: 'A name is required.', isError: true };
		}
		const root = this.root();
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;

		const found = (await getWorkspaceSymbols(name, token))
			.filter(item => item.symbol.location.uri.path.startsWith(rootPath));

		if (found.length === 0) {
			return {
				content: `No declaration of ${name} found. Either it is not declared in this project, ` +
					`or no language extension for it is installed — search_files will still find the text.`,
			};
		}

		const lines = found.slice(0, MAX_SYMBOLS).map(item => {
			const { symbol } = item;
			const path = symbol.location.uri.path.slice(rootPath.length);
			const line = symbol.location.range.startLineNumber;
			// SymbolKind is a const enum, so there is no reverse lookup from the
			// number back to the name. The editor keeps its own map of kind to a
			// word — the same words the outline view shows — so use that rather
			// than writing a second list here that would drift from it.
			const kind = symbolKindNames[symbol.kind] ?? 'symbol';
			const container = symbol.containerName ? ` in ${symbol.containerName}` : '';
			return `${path}:${line} ${kind} ${symbol.name}${container}`;
		});

		const capped = found.length > MAX_SYMBOLS ? `\n\n(${MAX_SYMBOLS} shown; there are more.)` : '';
		return { content: lines.join('\n') + capped };
	}

	/**
	 * Run something, once the person has said yes.
	 *
	 * The permission is not here. It is in whatever implements
	 * `IAgentCommandRunner` — the panel — because asking is a thing only the
	 * panel can do, and because keeping it out of this file is what lets
	 * every other tool in here be tested with no window at all.
	 *
	 * What is here is the reporting, and it matters more than it looks. The
	 * model has to be able to tell these three apart:
	 *
	 *   - the command ran and succeeded
	 *   - the command ran and failed, and here is what it printed
	 *   - the command never ran, because the person said no
	 *
	 * Collapse the third into the second and the agent tries again, louder,
	 * having learned that the command "failed". So a refusal is not an error:
	 * it is a plain answer saying the person declined, which is information
	 * rather than a fault to retry.
	 */
	private async runCommand(input: Record<string, unknown>, token: CancellationToken): Promise<AgentToolResult> {
		const command = typeof input.command === 'string' ? input.command.trim() : '';
		if (!command) {
			return { content: 'A command is required.', isError: true };
		}
		if (!this.commandRunner) {
			return { content: 'Commands cannot be run here.', isError: true };
		}

		const result = await this.commandRunner.run(command, token);

		if (result.refused) {
			return {
				content: `The person did not allow this command. Do not ask for it again unless ` +
					`they bring it up. Carry on with what you can do without it, and say plainly ` +
					`if there is something you now cannot check.`,
			};
		}
		if (result.error) {
			return { content: `The command could not be run: ${result.error}`, isError: true };
		}

		const output = result.output.trim();
		const body = output || '(no output)';

		// No exit code means the shell has no integration installed, so the
		// end of the command could not be detected. Saying "exit 0" there
		// would be a guess, and a guess the model would act on.
		if (result.exitCode === undefined) {
			return {
				content: `${body}\n\n(This shell does not report exit codes, so whether the ` +
					`command succeeded has to be read from the output above.)`,
			};
		}
		if (result.exitCode === 0) {
			return { content: body };
		}
		return { content: `Exited ${result.exitCode}.\n\n${body}`, isError: true };
	}

	/**
	 * Who uses this.
	 *
	 * The question a person asks before changing a signature, and the one
	 * text search answers worst: grepping a name like `run` or `send` buries
	 * the four call sites that matter under four hundred that do not, and
	 * misses the one that imported it under another name.
	 *
	 * Reference providers answer it properly, but they want a position in a
	 * text model, not a name. So this does the two steps a person does: find
	 * the declaration by name, then ask at the spot where the name is written
	 * in it. The column matters — asking at the start of the declaration line
	 * lands on `export` or `function` and gets nothing back — so the name is
	 * located within the line rather than assumed to be at its start.
	 *
	 * The model reference is released in a `finally`. Leaving one open holds
	 * the file's text in memory for as long as the window lives.
	 */
	private async findReferences(input: Record<string, unknown>, token: CancellationToken): Promise<AgentToolResult> {
		const name = typeof input.name === 'string' ? input.name.trim() : '';
		if (!name) {
			return { content: 'A name is required.', isError: true };
		}
		const root = this.root();
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
		const wantedPath = typeof input.path === 'string' && input.path.trim()
			? this.resolvePath(input.path).uri.path
			: undefined;

		// An exact-name match, because `provideWorkspaceSymbols` matches
		// loosely: searching for `run` offers `runAgentLoop` too, and asking
		// for the references of the wrong symbol is worse than finding none.
		const candidates = (await getWorkspaceSymbols(name, token))
			.map(item => item.symbol)
			.filter(symbol => symbol.name === name)
			.filter(symbol => symbol.location.uri.path.startsWith(rootPath))
			.filter(symbol => !wantedPath || symbol.location.uri.path === wantedPath);

		if (candidates.length === 0) {
			return {
				content: `No declaration of ${name} found, so there is nothing to look up. ` +
					`find_symbol will say whether it is declared in this project at all.`,
			};
		}

		// Several declarations with the same name is a real situation — an
		// interface and its implementation, a method on two classes. Say so
		// and answer for the first rather than silently picking one, so the
		// model can ask again with a path if that was the wrong one.
		const target = candidates[0];
		const others = candidates.length > 1
			? `\n\n(${candidates.length} things are called ${name}; this is the one in ` +
			`${target.location.uri.path.slice(rootPath.length)}. Pass \`path\` to ask about another.)`
			: '';

		const reference = await this.textModelService.createModelReference(target.location.uri);
		try {
			const model = reference.object.textEditorModel;
			const declarationLine = target.location.range.startLineNumber;
			const text = model.getLineContent(declarationLine);
			const column = text.indexOf(name);
			const position = new Position(declarationLine, column >= 0 ? column + 1 : target.location.range.startColumn);

			const links = await getReferencesAtPosition(
				this.languageFeaturesService.referenceProvider, model, position, false, false, token);

			const uses = links
				.filter(link => link.uri.path.startsWith(rootPath))
				// The declaration itself comes back as a reference. It is not
				// a use, and the model already knows where it is.
				.filter(link => !(link.uri.path === target.location.uri.path
					&& link.range.startLineNumber === declarationLine));

			if (uses.length === 0) {
				return {
					content: `${name} is declared in ${target.location.uri.path.slice(rootPath.length)}:` +
						`${declarationLine} and nothing in this project uses it.${others}`,
				};
			}

			// Grouped by file, because that is how the answer gets used: a
			// file with eleven call sites is one file to open, not eleven
			// lines to read past.
			const byFile = new Map<string, number[]>();
			for (const link of uses) {
				const path = link.uri.path.slice(rootPath.length);
				const at = byFile.get(path);
				if (at) {
					at.push(link.range.startLineNumber);
				} else {
					byFile.set(path, [link.range.startLineNumber]);
				}
			}

			let shown = 0;
			const lines: string[] = [];
			for (const [path, at] of byFile) {
				if (shown >= MAX_REFERENCES) {
					break;
				}
				const room = at.slice(0, MAX_REFERENCES - shown).sort((a, b) => a - b);
				shown += room.length;
				lines.push(`${path}: line${room.length === 1 ? '' : 's'} ${room.join(', ')}`);
			}

			const capped = shown < uses.length ? `\n\n(${shown} of ${uses.length} shown.)` : '';
			return {
				content: `${uses.length} use${uses.length === 1 ? '' : 's'} of ${name} in ` +
					`${byFile.size} file${byFile.size === 1 ? '' : 's'}:\n` +
					lines.join('\n') + capped + others,
			};
		} finally {
			reference.dispose();
		}
	}

	/**
	 * What the editor is complaining about.
	 *
	 * This is the one thing the agent can do here that it could not do from a
	 * terminal: every language server the person has installed is already
	 * running, has already parsed the project, and has already decided what is
	 * wrong with it. Asking costs one call and no compilation.
	 *
	 * It reports what is on disk. A staged edit has not been written, so it is
	 * not reflected — the tool's own description says so, because an agent
	 * that thinks it has verified a change it has not applied is worse than
	 * one that never checked.
	 */
	private diagnostics(input: Record<string, unknown>): AgentToolResult {
		const root = this.root();
		const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
		const wanted = typeof input.path === 'string' && input.path.trim()
			? this.resolvePath(input.path).uri
			: undefined;

		const severities = input.includeWarnings === true
			? MarkerSeverity.Error | MarkerSeverity.Warning
			: MarkerSeverity.Error;

		const markers = this.markerService.read({
			...(wanted ? { resource: wanted } : {}),
			severities,
			take: MAX_MARKERS + 1,
		}).filter(m => m.resource.path.startsWith(rootPath));

		if (markers.length === 0) {
			const scope = wanted ? this.resolvePath(input.path).relative : 'the project';
			return {
				content: input.includeWarnings === true
					? `No errors or warnings in ${scope}.`
					: `No errors in ${scope}.`,
			};
		}

		const lines = markers.slice(0, MAX_MARKERS).map(m => {
			const path = m.resource.path.slice(rootPath.length);
			const kind = m.severity === MarkerSeverity.Error ? 'error' : 'warning';
			const source = m.source ? ` [${m.source}]` : '';
			return `${path}:${m.startLineNumber}:${m.startColumn} ${kind}${source}: ${m.message}`;
		});

		const capped = markers.length > MAX_MARKERS
			? `\n\n(${MAX_MARKERS} shown; there are more.)`
			: '';
		return { content: lines.join('\n') + capped };
	}

	/** What the file will hold once everything staged for it is applied. */
	private async currentText(uri: URI, relative: string): Promise<string | undefined> {
		const staged = this.staged.get(relative);
		if (staged) {
			return staged.after;
		}
		if (!(await this.fileService.exists(uri))) {
			return undefined;
		}
		return (await this.fileService.readFile(uri)).value.toString();
	}

	private async editFile(input: Record<string, unknown>): Promise<AgentToolResult> {
		const { uri, relative } = this.resolvePath(input.path);
		const find = typeof input.find === 'string' ? input.find : '';
		const replace = typeof input.replace === 'string' ? input.replace : '';
		if (!find) {
			return { content: '`find` is required, and must be text that appears in the file.', isError: true };
		}

		const before = await this.currentText(uri, relative);
		if (before === undefined) {
			return { content: `There is no file at ${relative}. Use write_file to create it.`, isError: true };
		}

		const first = before.indexOf(find);
		if (first === -1) {
			return { content: `That text is not in ${relative}. Read the file and use text from it exactly.`, isError: true };
		}
		// Refused rather than guessed: replacing the first of several is how an
		// edit silently lands in the wrong place.
		if (before.indexOf(find, first + find.length) !== -1) {
			return {
				content: `That text appears more than once in ${relative}. Include enough surrounding lines to make it unique.`,
				isError: true,
			};
		}

		const after = before.slice(0, first) + replace + before.slice(first + find.length);
		this.staged.set(relative, {
			path: relative,
			before: this.staged.get(relative)?.before ?? before,
			after,
		});
		return { content: `Staged an edit to ${relative}. It is shown to the person as a diff and applied only if they accept it.` };
	}

	private async writeFile(input: Record<string, unknown>): Promise<AgentToolResult> {
		const { uri, relative } = this.resolvePath(input.path);
		const content = typeof input.content === 'string' ? input.content : undefined;
		if (content === undefined) {
			return { content: '`content` is required.', isError: true };
		}
		const existing = this.staged.get(relative)?.before
			?? (await this.fileService.exists(uri)
				? (await this.fileService.readFile(uri)).value.toString()
				: undefined);

		this.staged.set(relative, { path: relative, before: existing, after: content });
		const verb = existing === undefined ? 'creating' : 'replacing';
		return { content: `Staged ${verb} ${relative}. It is shown to the person as a diff and applied only if they accept it.` };
	}

	/** Write every staged change to disk. Called when a person accepts them. */
	async applyStaged(): Promise<readonly string[]> {
		const written: string[] = [];
		for (const edit of this.staged.values()) {
			const { uri } = this.resolvePath(edit.path);
			await this.fileService.writeFile(uri, VSBuffer.fromString(edit.after));
			written.push(edit.path);
		}
		this.staged.clear();
		return written;
	}
}
