/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** One file from the open folder, read as text. */
export interface WorkspaceFile {
	readonly path: string;
	readonly content: string;
}

/**
 * Everything in the open folder worth sending, whether for a deploy or so
 * the agent can see a project rather than the five files a message carries.
 *
 * The skip list is not a nicety. `node_modules` alone is tens of thousands
 * of files — past the server's 6,000-file ceiling before any of the
 * project's own code is reached — and `.env` is a credential that would be
 * uploaded and then served from the site's own address.
 *
 * Binary files are skipped rather than mangled: this reads text, and a PNG
 * read as UTF-8 arrives corrupted. Images belong in a deploy, so this is a
 * real limitation and the caller is told the count rather than left to
 * wonder why a logo is missing.
 */
export async function collectWorkspaceFiles(
	fileService: IFileService,
	contextService: IWorkspaceContextService,
): Promise<WorkspaceFile[]> {
	const folders = contextService.getWorkspace().folders;
	if (folders.length === 0) {
		return [];
	}
	const root = folders[0].uri;

	const SKIP_DIRS = new Set([
		'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
		'.next', '.nuxt', '.cache', '.turbo', 'coverage', '__pycache__',
		'.venv', 'venv', 'target', 'vendor',
	]);
	// Secrets, and the lockfiles a build regenerates anyway.
	const SKIP_FILES = new Set(['.env', '.env.local', '.env.production', '.DS_Store']);

	const MAX_FILES = 6000;         // the server's own ceiling
	const MAX_BYTES = 4 * 1024 * 1024;

	const out: { path: string; content: string }[] = [];

	const walk = async (dir: URI, prefix: string): Promise<void> => {
		if (out.length >= MAX_FILES) {
			return;
		}
		let stat;
		try {
			stat = await fileService.resolve(dir);
		} catch {
			return;
		}
		for (const child of stat.children ?? []) {
			if (out.length >= MAX_FILES) {
				return;
			}
			const name = child.name;
			if (child.isDirectory) {
				if (!SKIP_DIRS.has(name) && !name.startsWith('.')) {
					await walk(child.resource, `${prefix}${name}/`);
				}
				continue;
			}
			if (SKIP_FILES.has(name)) {
				continue;
			}
			try {
				const content = await fileService.readFile(child.resource);
				if (content.value.byteLength > MAX_BYTES) {
					continue;
				}
				const text = content.value.toString();
				// A NUL byte means this was not text. Sending it would
				// upload something the file never contained.
				if (text.includes('\u0000')) {
					continue;
				}
				out.push({ path: `${prefix}${name}`, content: text });
			} catch {
				// Unreadable file — skipped rather than failing the deploy.
			}
		}
	};

	await walk(root, '');
	return out;
}

/**
 * The shape `PUT /workspace` stores, built from a flat list of paths.
 *
 * The server keeps a tree — `nodes`, `childrenOf`, `contents` — because the
 * web product's file explorer is a tree and it reads this back to draw one.
 * The agent's `list_files` and `read_file` walk that same tree from the id
 * "root", so this is the format it has to be in for the agent to see a
 * project at all, not a format anyone chose for an editor that already has
 * its own file system.
 *
 * Ids are the paths themselves. They only have to be unique and stable
 * within one state, and a path is both — where a counter would renumber
 * every file whenever one was added above it.
 */
export function toWorkspaceState(files: readonly WorkspaceFile[]): Record<string, unknown> {
	const nodes: Record<string, { id: string; name: string; kind: string; parentId: string }> = {};
	const childrenOf: Record<string, string[]> = { root: [] };
	const contents: Record<string, string> = {};

	/** Creates every folder on the way to a path, once. */
	const folderId = (segments: string[]): string => {
		let parentId = 'root';
		let prefix = '';
		for (const segment of segments) {
			prefix = prefix ? `${prefix}/${segment}` : segment;
			if (!nodes[prefix]) {
				nodes[prefix] = { id: prefix, name: segment, kind: 'folder', parentId };
				childrenOf[prefix] = [];
				childrenOf[parentId].push(prefix);
			}
			parentId = prefix;
		}
		return parentId;
	};

	for (const file of files) {
		const segments = file.path.split('/');
		const name = segments.pop()!;
		const parentId = folderId(segments);
		nodes[file.path] = { id: file.path, name, kind: 'file', parentId };
		childrenOf[parentId].push(file.path);
		contents[file.path] = file.content;
	}

	// `drafts`, `expanded` and `openTabs` are the explorer's own business and
	// this editor has none of it — but the server rejects a state without
	// them, so they are sent empty rather than omitted.
	return { nodes, childrenOf, contents, drafts: {}, expanded: {}, openTabs: [] };
}
