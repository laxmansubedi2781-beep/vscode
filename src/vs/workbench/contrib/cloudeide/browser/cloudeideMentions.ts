/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Naming a file in the question, with `@`.
 *
 * Without it, "fix the bug in the cart badge" costs the agent two or three
 * tool calls before it is looking at the right file — a list, a search, a
 * read, each one a round trip and a slice of the context budget — and it
 * sometimes lands on the wrong one. The person asking already knew which
 * file they meant. This is how they say so.
 *
 * Deliberately not a quick pick. Ctrl+P's picker is better at finding a file
 * you cannot name, but it takes the whole window and takes the person out of
 * the sentence they were half-way through writing. This stays under the box,
 * filters as they type, and puts the path back where the caret was.
 *
 * It searches the workspace with the same service the Explorer's own file
 * search uses, so it respects `files.exclude`, `.gitignore` where that is
 * configured, and the sort order people are used to.
 */

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { findSlash, matchingCommands } from './cloudeideCommands.js';

const $ = DOM.$;

/** How many files the list offers at once. */
const MAX_SHOWN = 8;

/**
 * What the caret is sitting in, when it is sitting in a mention.
 *
 * `start` is the index of the `@`, `query` is whatever has been typed after
 * it. A mention ends at the first space, because a path with a space in it is
 * rare and a sentence that keeps matching after the file name is not.
 */
interface ActiveMention {
	readonly start: number;
	readonly query: string;
}

export function findMention(text: string, caret: number): ActiveMention | undefined {
	const before = text.slice(0, caret);
	const at = before.lastIndexOf('@');
	if (at === -1) {
		return undefined;
	}
	// Only at the start of a word, so an email address or a decorator is not
	// mistaken for somebody asking for a file.
	const preceding = at === 0 ? ' ' : before[at - 1];
	if (!/\s/.test(preceding)) {
		return undefined;
	}
	const query = before.slice(at + 1);
	if (/\s/.test(query)) {
		return undefined;
	}
	return { start: at, query };
}

export class CloudeideMentions extends Disposable {

	private readonly list: HTMLElement;
	private readonly search = this._register(new MutableDisposable<CancellationTokenSource>());

	private paths: string[] = [];
	private commands: { name: string; hint: string }[] = [];
	private active = 0;
	private mention: ActiveMention | undefined;

	constructor(
		container: HTMLElement,
		private readonly input: HTMLTextAreaElement,
		private readonly contextService: IWorkspaceContextService,
		private readonly searchService: ISearchService,
		private readonly queryBuilder: QueryBuilder,
	) {
		super();

		this.list = DOM.append(container, $('.cloudeide-mentions'));
		this.list.style.display = 'none';
		this.list.setAttribute('role', 'listbox');

		this._register(DOM.addDisposableListener(this.input, 'input', () => void this.refresh()));
		this._register(DOM.addDisposableListener(this.input, 'blur', () => {
			// A click on a row blurs the box before the click lands, so the
			// close waits a frame. Hiding immediately makes the list
			// unclickable, which is a bug that looks like nothing happening.
			setTimeout(() => this.close(), 120);
		}));
	}

	/** True while the list is showing, so the composer's keys can defer to it. */
	get open(): boolean {
		return this.list.style.display !== 'none';
	}

	/**
	 * Gives the list first refusal on a keystroke.
	 *
	 * Returns true when it took it. Enter has to be intercepted or the
	 * message is sent instead of the file being chosen, which is the sort of
	 * thing that makes people stop using a feature after one try.
	 */
	handleKey(event: KeyboardEvent): boolean {
		if (!this.open) {
			return false;
		}
		switch (event.key) {
			case 'ArrowDown':
				this.move(1);
				return true;
			case 'ArrowUp':
				this.move(-1);
				return true;
			case 'Enter':
			case 'Tab':
				this.chooseAt(this.active);
				return true;
			case 'Escape':
				this.close();
				return true;
			default:
				return false;
		}
	}

	private async refresh(): Promise<void> {
		/*
		 * One list, two things that open it.
		 *
		 * `/` and `@` want the same box in the same place with the same keys;
		 * two popups would be two sets of arrow-key handling and two ways for
		 * Enter to go wrong. The rows differ, the machinery does not.
		 */
		const slash = findSlash(this.input.value, this.input.selectionStart ?? 0);
		if (slash) {
			this.mention = undefined;
			const found = matchingCommands(slash.query);
			if (found.length === 0) {
				this.close();
				return;
			}
			this.commands = found.map(c => ({ name: `/${c.name}`, hint: c.summary }));
			this.paths = [];
			this.render();
			return;
		}
		this.commands = [];

		const mention = findMention(this.input.value, this.input.selectionStart ?? 0);
		this.mention = mention;
		if (!mention) {
			this.close();
			return;
		}

		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.close();
			return;
		}

		// Each keystroke cancels the last search. Without this a fast typist
		// gets the answers to three prefixes back in whatever order they
		// finish, and the list flickers between them.
		const source = new CancellationTokenSource();
		this.search.value = source;

		try {
			const query = this.queryBuilder.file(folders, {
				filePattern: mention.query,
				sortByScore: true,
				maxResults: MAX_SHOWN,
				cacheKey: 'cloudeide.mentions',
			});
			const result = await this.searchService.fileSearch(query, source.token);
			if (source.token.isCancellationRequested) {
				return;
			}

			const root = folders[0].uri.path.replace(/\/+$/, '');
			this.paths = result.results
				.map(match => match.resource.path)
				.map(path => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)
				.slice(0, MAX_SHOWN);
			this.render();
		} catch {
			this.close();
		}
	}

	private render(): void {
		DOM.clearNode(this.list);
		const rows = this.commands.length > 0
			? this.commands
			: this.paths.map(path => {
				// The file's own name first and the folder after it, dimmed:
				// twenty rows of `src/components/…` all start the same way,
				// and the part that tells them apart is at the end.
				const cut = path.lastIndexOf('/');
				return { name: cut === -1 ? path : path.slice(cut + 1), hint: cut === -1 ? '' : path.slice(0, cut) };
			});

		if (rows.length === 0) {
			this.close();
			return;
		}

		this.active = Math.min(this.active, rows.length - 1);
		this.list.style.display = '';

		rows.forEach((entry, index) => {
			const row = DOM.append(this.list, $('button.cloudeide-mention')) as HTMLButtonElement;
			row.classList.toggle('cloudeide-mention-active', index === this.active);
			row.setAttribute('role', 'option');

			const name = DOM.append(row, $('span.cloudeide-mention-name'));
			name.textContent = entry.name;
			if (entry.hint) {
				const where = DOM.append(row, $('span.cloudeide-mention-where'));
				where.textContent = entry.hint;
			}

			this._register(DOM.addDisposableListener(row, 'mousedown', event => {
				// mousedown, not click: the box's blur fires first otherwise
				// and the list is gone before the click arrives.
				DOM.EventHelper.stop(event, true);
				this.chooseAt(index);
			}));
		});
	}

	private chooseAt(index: number): void {
		if (this.commands.length > 0) {
			this.chooseCommand(this.commands[index]?.name);
			return;
		}
		this.choose(this.paths[index]);
	}

	/**
	 * A command replaces the word, and leaves the caret after it.
	 *
	 * With a space, so `/test the cart ones` is one keystroke away from
	 * `/test` — a command that carries the rest of the sentence is a common
	 * enough thing to want that it should not need a second thought.
	 */
	private chooseCommand(name: string | undefined): void {
		if (!name) {
			this.close();
			return;
		}
		const text = this.input.value;
		const firstSpace = text.indexOf(' ');
		const rest = firstSpace === -1 ? '' : text.slice(firstSpace);
		this.input.value = `${name}${rest || ' '}`;
		const caret = name.length + 1;
		this.input.setSelectionRange(caret, caret);
		this.input.focus();
		this.close();
	}

	private move(by: number): void {
		const count = this.commands.length > 0 ? this.commands.length : this.paths.length;
		if (count === 0) {
			return;
		}
		this.active = (this.active + by + count) % count;
		this.render();
	}

	private choose(path: string | undefined): void {
		const mention = this.mention;
		if (!path || !mention) {
			this.close();
			return;
		}

		const text = this.input.value;
		const after = mention.start + 1 + mention.query.length;
		// A trailing space, because the next thing typed is the rest of the
		// sentence and nobody wants to press space after picking from a list.
		const replacement = `@${path} `;
		this.input.value = text.slice(0, mention.start) + replacement + text.slice(after);

		const caret = mention.start + replacement.length;
		this.input.setSelectionRange(caret, caret);
		this.input.focus();
		this.input.dispatchEvent(new Event('input'));
		this.close();
	}

	private close(): void {
		this.commands = [];
		this.search.clear();
		this.list.style.display = 'none';
		this.active = 0;
		this.mention = undefined;
	}
}

/**
 * Turns `@path` into something the agent can act on.
 *
 * The model is told plainly which files were named rather than being left to
 * notice an `@` in the middle of a sentence and work out what it meant. The
 * sentence itself is passed through unchanged, because the `@` reads as
 * English — "fix @Cart.tsx" is a thing a person would write — and stripping
 * it would make the transcript differ from what they typed.
 */
export function mentionedFiles(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
		const path = match[1].replace(/[.,;:)]+$/, '');
		if (path) {
			found.add(path);
		}
	}
	return [...found];
}

export function mentionNote(paths: readonly string[]): string | undefined {
	if (paths.length === 0) {
		return undefined;
	}
	return localize('cloudeide.mentions.note',
		"They named these files in the question, so start with them: {0}", paths.join(', '));
}
