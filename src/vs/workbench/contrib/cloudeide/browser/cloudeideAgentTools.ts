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
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';

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
];

export class CloudeideAgentTools {

	/** Staged writes, by path. The last one for a path wins, as it would on disk. */
	private readonly staged = new Map<string, StagedEdit>();

	constructor(
		private readonly fileService: IFileService,
		private readonly contextService: IWorkspaceContextService,
		private readonly searchService: ISearchService,
		private readonly queryBuilder: QueryBuilder,
	) { }

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
				case 'edit_file': return await this.editFile(input);
				case 'write_file': return await this.writeFile(input);
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
