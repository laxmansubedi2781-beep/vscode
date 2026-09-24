/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One place a change is looked at: the file it is in.
 *
 * There were two, and that was the problem. A run ended, the panel drew a
 * diff inside a three-hundred-pixel column, somebody read it there, pressed
 * Apply, and then opened the file and read the same change again — this time
 * in the place where it actually matters, with the rest of the code around
 * it. Two readings of one change, the first of them in the worse of the two
 * places.
 *
 * So the change goes into the files straight away, as an unsaved edit, and
 * the editor shows it the way the editor shows everything: real code, real
 * syntax colouring, real surroundings, with what the agent touched marked
 * green and red. Nothing is on disk yet. Keep saves it; Undo puts the files
 * back exactly as they were.
 *
 * Which means the panel no longer has to be a diff viewer. It lists what
 * changed and by how much, and that is all it needs to be.
 *
 * None of the machinery here is new. `IBulkEditService` applies edits across
 * files as one undoable step and leaves the buffers dirty — it is what every
 * rename and every quick fix in this editor already uses — and undoing is
 * the undo stack, not a copy of the old text kept in a variable. The one
 * thing this adds is the marks.
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IUndoRedoService, UndoRedoSource } from '../../../../platform/undoRedo/common/undoRedo.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { CloudeideAppliedMarks } from './cloudeideAppliedMarks.js';
import type { FileChange } from './cloudeideClient.js';

/** What the panel needs to draw its line for one file. */
export interface PreviewedFile {
	readonly path: string;
	readonly kind: FileChange['kind'];
	readonly added: number;
	readonly removed: number;
}

export class CloudeideEditPreview extends Disposable {

	/**
	 * The undo group for the run currently on screen.
	 *
	 * One source per run, so Undo takes back everything that run did and
	 * nothing the person did afterwards — including in files the run never
	 * touched.
	 */
	private source: UndoRedoSource | undefined;
	private touched: URI[] = [];

	constructor(
		private readonly marks: CloudeideAppliedMarks,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IUndoRedoService private readonly undoRedoService: IUndoRedoService,
	) {
		super();
	}

	/**
	 * Puts the run's changes into the buffers and shows the first one.
	 *
	 * Nothing reaches the disk here. A person who walks away and closes the
	 * window is asked about unsaved files, which is the same question the
	 * editor asks about their own unsaved work, and the right one.
	 */
	async show(root: URI, changes: readonly FileChange[]): Promise<readonly PreviewedFile[]> {
		this.forgetPending();

		const rootPath = root.path.replace(/\/+$/, '');
		const edits: (ResourceTextEdit | ResourceFileEdit)[] = [];
		const touched: URI[] = [];

		for (const change of changes) {
			const uri = root.with({ path: `${rootPath}/${change.path}` });
			if (!uri.path.startsWith(`${rootPath}/`)) {
				throw new Error(localize('cloudeide.preview.outside',
					"Refused to touch a file outside the folder: {0}", change.path));
			}
			touched.push(uri);

			if (change.kind === 'delete') {
				/*
				 * A delete happens on disk, now, unlike everything else here.
				 *
				 * There is no such thing as an unsaved deletion — a buffer
				 * cannot represent "this file is not here". Undo puts it back
				 * (the bulk edit keeps the contents for that), and `maxSize`
				 * is what decides whether it can: a file larger than this is
				 * deleted without being recoverable, so it is refused instead.
				 */
				edits.push(new ResourceFileEdit(uri, undefined, { maxSize: 8 * 1024 * 1024 }));
				continue;
			}

			// A file that does not exist yet is a create, whatever the change
			// called itself: an agent that edited a file somebody deleted
			// underneath it should still land its work, not fail the run.
			const exists = change.kind === 'create' ? false : await this.fileService.exists(uri);

			if (!exists) {
				// `contents` on the create rather than a create plus a text
				// edit: one step, so Undo takes the file away rather than
				// emptying it and leaving a stray behind.
				edits.push(new ResourceFileEdit(undefined, uri, {
					overwrite: true,
					contents: Promise.resolve(VSBuffer.fromString(change.after ?? '')),
				}));
				continue;
			}

			// An edit: replace the whole file. The agent's tools hand over
			// whole contents rather than ranges, and the diff behind the
			// green and red marks is computed from before/after anyway.
			const model = await this.textModelService.createModelReference(uri);
			try {
				edits.push(new ResourceTextEdit(uri, {
					range: model.object.textEditorModel.getFullModelRange(),
					text: change.after ?? '',
				}));
			} finally {
				model.dispose();
			}
		}

		if (edits.length === 0) {
			return [];
		}

		this.source = new UndoRedoSource();
		this.touched = touched;

		await this.bulkEditService.apply(edits, {
			label: localize('cloudeide.preview.label', "CloudeIDE agent"),
			code: 'cloudeide.agentEdit',
			quotableLabel: 'CloudeIDE agent',
			undoRedoSource: this.source,
			// Not saved by an autosave setting behind the person's back: the
			// whole point is that Keep is theirs to press.
			respectAutoSaveConfig: false,
		});

		const marked = await this.marks.mark(root, changes);

		const first = marked[0] ?? undefined;
		if (first) {
			await this.editorService.openEditor({
				resource: root.with({ path: `${rootPath}/${first.path}` }),
				options: { preserveFocus: true },
			}).catch(() => { /* the marks are on the model either way */ });
		}

		const counts = new Map(marked.map(m => [m.path, m]));
		return changes.map(change => ({
			path: change.path,
			kind: change.kind,
			added: counts.get(change.path)?.added ?? 0,
			removed: counts.get(change.path)?.removed ?? 0,
		}));
	}

	/** Saves what the run wrote. Returns how many files reached the disk. */
	async keep(): Promise<number> {
		let saved = 0;
		for (const uri of this.touched) {
			// A deleted file has nothing to save, and a file somebody already
			// saved by hand is not dirty any more.
			if ((await this.fileService.exists(uri)) && this.textFileService.isDirty(uri)) {
				await this.textFileService.save(uri);
				saved++;
			}
		}
		this.settle();
		return saved;
	}

	/**
	 * Puts every file back the way it was.
	 *
	 * Through the undo stack rather than by rewriting the old text, so it is
	 * one step in the same history the person's own Ctrl+Z walks, and so a
	 * created file is removed rather than left behind empty.
	 */
	async undo(): Promise<void> {
		const source = this.source;
		if (source) {
			await this.undoRedoService.undo(source);
		}
		this.settle();
	}

	/** True while a run's changes are in the buffers, unsaved. */
	get pending(): boolean {
		return this.source !== undefined;
	}

	/**
	 * A second run starting on top of a first one nobody answered.
	 *
	 * The earlier change is left in the buffers, not reverted: the person has
	 * had it on screen and has been working beside it, and taking it back
	 * because they asked another question would lose work they could
	 * reasonably think was theirs. What is dropped is this object's hold on
	 * it — its Keep and Undo settle with the card they belong to, and the new
	 * run gets its own.
	 */
	private forgetPending(): void {
		this.settle();
	}

	private settle(): void {
		this.marks.clear();
		this.source = undefined;
		this.touched = [];
	}
}
