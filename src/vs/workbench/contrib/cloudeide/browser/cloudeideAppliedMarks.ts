/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the agent just changed, marked in the file itself.
 *
 * Pressing Apply used to write the files and say so in the panel, and that
 * was the end of it. The person then opened the file and looked at a wall of
 * code with no idea which four lines were new — which is the moment where
 * trusting an agent gets expensive, because the only way to check its work
 * was to re-read the whole file.
 *
 * So the change is marked where the change is: added and rewritten lines get
 * a green band and a green bar in the gutter, and the place a line was
 * deleted from gets a red bar. The marks are deliberately stronger than the
 * diff editor's own, because this is not a diff view somebody opened on
 * purpose — it is a file they are about to keep working in, and the marks
 * have to survive being glanced at.
 *
 * They are decorations on the model, not an overlay, so they show in every
 * editor and every split showing that file, they move correctly when the
 * person types above them, and they cost nothing to draw.
 *
 * They go away when the person edits the file. At that point the file is no
 * longer "what the agent did" and pretending otherwise would leave green
 * bands on lines somebody wrote themselves.
 */

import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerColor, transparent } from '../../../../platform/theme/common/colorRegistry.js';
import { themeColorFromId } from '../../../../platform/theme/common/themeService.js';
import { OverviewRulerLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import type { FileChange } from './cloudeideClient.js';

/*
 * Stronger than the diff editor's, on purpose.
 *
 * `diffEditor.insertedLineBackground` is about 15% opaque, which is right for
 * a two-pane view where the colour only has to separate two halves of a
 * screen that are already side by side. Here it is one file, seen at a
 * glance, often over syntax highlighting — at 15% the band disappears. These
 * are the same hues, at roughly twice the weight.
 */
export const appliedAddedBackground = registerColor('cloudeide.appliedAddedBackground',
	{ dark: '#3fb95038', light: '#2ea04333', hcDark: '#3fb95060', hcLight: '#2ea04340' },
	localize('cloudeide.appliedAddedBackground', "Background of a line the agent added or rewrote, until the file is edited."));

export const appliedAddedBorder = registerColor('cloudeide.appliedAddedBorder',
	{ dark: '#3fb950', light: '#2ea043', hcDark: '#3fb950', hcLight: '#2ea043' },
	localize('cloudeide.appliedAddedBorder', "The bar in the gutter beside a line the agent added or rewrote."));

export const appliedRemovedBorder = registerColor('cloudeide.appliedRemovedBorder',
	{ dark: '#f85149', light: '#cf222e', hcDark: '#f85149', hcLight: '#cf222e' },
	localize('cloudeide.appliedRemovedBorder', "The mark in the gutter where the agent deleted lines."));

export const appliedRemovedBackground = registerColor('cloudeide.appliedRemovedBackground',
	{ dark: transparent(appliedRemovedBorder, 0.22), light: transparent(appliedRemovedBorder, 0.18), hcDark: transparent(appliedRemovedBorder, 0.4), hcLight: transparent(appliedRemovedBorder, 0.3) },
	localize('cloudeide.appliedRemovedBackground', "Background shown where the agent deleted lines."));

const DIFF_OPTIONS = {
	ignoreTrimWhitespace: false,
	maxComputationTimeMs: 1000,
	computeMoves: false,
};

/*
 * `NeverGrowsWhenTypingAtEdges` rather than the default.
 *
 * With the default stickiness, typing a character at the end of a marked line
 * extends the mark over what was just typed — so the green band starts
 * claiming the person's own work. It should stay exactly the size it was
 * written at, and vanish on the next edit anyway.
 */
const ADDED = ModelDecorationOptions.register({
	description: 'cloudeide-applied-added',
	className: 'cloudeide-applied-added',
	linesDecorationsClassName: 'cloudeide-applied-added-gutter',
	isWholeLine: true,
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	overviewRuler: {
		color: themeColorFromId(appliedAddedBorder),
		position: OverviewRulerLane.Left,
	},
});

const REMOVED = ModelDecorationOptions.register({
	description: 'cloudeide-applied-removed',
	linesDecorationsClassName: 'cloudeide-applied-removed-gutter',
	isWholeLine: true,
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	overviewRuler: {
		color: themeColorFromId(appliedRemovedBorder),
		position: OverviewRulerLane.Left,
	},
});

/** What one file's marks amount to, for the line the panel prints. */
export interface MarkedChange {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
}

export class CloudeideAppliedMarks extends Disposable {

	/** One entry per marked file; disposing it removes that file's marks. */
	private readonly marked = new Map<string, IDisposable>();

	constructor(private readonly textModelService: ITextModelService) {
		super();
		this._register(toDisposable(() => this.clear()));
	}

	/**
	 * Marks every file a run changed, and says what it marked.
	 *
	 * Called after the write, not before: the decorations are placed against
	 * the text that is now on disk, so their line numbers are the ones the
	 * person will see.
	 */
	async mark(root: URI, changes: readonly FileChange[]): Promise<MarkedChange[]> {
		this.clear();
		const marked: MarkedChange[] = [];

		for (const change of changes) {
			if (change.kind === 'delete') {
				// The file is gone. There is nothing left to decorate, and the
				// panel's card already names it.
				continue;
			}
			const uri = root.with({ path: `${root.path.replace(/\/+$/, '')}/${change.path}` });
			const summary = await this.markOne(uri, change);
			if (summary) {
				marked.push(summary);
			}
		}
		return marked;
	}

	private async markOne(uri: URI, change: FileChange): Promise<MarkedChange | undefined> {
		let reference;
		try {
			reference = await this.textModelService.createModelReference(uri);
		} catch {
			// A file the workbench cannot open as text — a binary asset the
			// agent wrote. Nothing to mark, and nothing worth an error.
			return undefined;
		}

		try {
			const model = reference.object.textEditorModel;
			const before = toLines(change.before);
			const after = toLines(change.after);

			const ranges: { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; options: ModelDecorationOptions }[] = [];
			let added = 0;
			let removed = 0;

			if (change.kind === 'create') {
				// A whole new file: every line of it is new, which is worth
				// marking — it is how somebody sees at a glance that this file
				// did not exist before.
				added = model.getLineCount();
				if (added > 0) {
					ranges.push({
						range: { startLineNumber: 1, startColumn: 1, endLineNumber: added, endColumn: 1 },
						options: ADDED,
					});
				}
			} else {
				const diff = linesDiffComputers.getDefault().computeDiff(before, after, DIFF_OPTIONS);
				const lastLine = model.getLineCount();

				for (const mapping of diff.changes) {
					const from = mapping.modified.startLineNumber;
					const to = mapping.modified.endLineNumberExclusive - 1;
					const deletedHere = mapping.original.endLineNumberExclusive - mapping.original.startLineNumber;

					if (to >= from) {
						added += to - from + 1;
						ranges.push({
							range: { startLineNumber: from, startColumn: 1, endLineNumber: Math.min(to, lastLine), endColumn: 1 },
							options: ADDED,
						});
					}

					if (deletedHere > 0 && to < from) {
						// A pure deletion: nothing survives to paint, so the
						// mark goes in the gutter of the line that closed over
						// the gap. Clamped, because deleting the end of a file
						// leaves `from` past the last line.
						removed += deletedHere;
						const at = Math.min(Math.max(from, 1), lastLine);
						ranges.push({
							range: { startLineNumber: at, startColumn: 1, endLineNumber: at, endColumn: 1 },
							options: REMOVED,
						});
					} else {
						removed += deletedHere;
					}
				}
			}

			if (ranges.length === 0) {
				reference.dispose();
				return undefined;
			}

			const ids = model.deltaDecorations([], ranges);
			const store = new DisposableStore();
			store.add(toDisposable(() => {
				// `isDisposed` because the file may have been closed and its
				// model thrown away before the marks are cleared, and asking a
				// disposed model to drop decorations throws.
				if (!model.isDisposed()) {
					model.deltaDecorations(ids, []);
				}
			}));

			/*
			 * The marks belong to the agent's edit and nothing after it.
			 *
			 * The first thing the person types in this file makes the state on
			 * screen theirs rather than the agent's, and green bands on lines
			 * somebody wrote themselves would be a lie about who wrote what.
			 */
			store.add(model.onDidChangeContent(() => this.forget(uri)));
			// The model reference is what keeps this file loaded; released
			// with everything else when the marks go.
			store.add(reference);

			this.marked.set(uri.toString(), store);
			return { path: change.path, added, removed };
		} catch (err) {
			reference.dispose();
			throw err;
		}
	}

	private forget(uri: URI): void {
		const key = uri.toString();
		this.marked.get(key)?.dispose();
		this.marked.delete(key);
	}

	clear(): void {
		for (const store of this.marked.values()) {
			store.dispose();
		}
		this.marked.clear();
	}
}

function toLines(text: string | null | undefined): string[] {
	return !text ? [] : text.split(/\r\n|\r|\n/);
}
