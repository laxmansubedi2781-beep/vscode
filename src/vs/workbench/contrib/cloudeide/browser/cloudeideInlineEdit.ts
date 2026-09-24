/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Changing code where the code is.
 *
 * The panel is the right place for "build me a mission control view" and the
 * wrong place for "make this loop async". The second is a sentence about four
 * lines that are already on screen, and routing it through a chat means
 * describing where you are to something that cannot see you, waiting for a
 * whole run, and then reading a diff of a file you were already looking at.
 *
 * So: select the lines, press the key, say it, and the answer arrives between
 * the same two lines. Nothing reaches the disk — the edit lands in the buffer
 * as one undoable step, marked the same green and red the agent's changes
 * are, and Keep or Discard settles it.
 *
 * The box is a ZoneWidget, which is the editor's own way of putting a panel
 * between two lines: it pushes the code down rather than covering it, moves
 * when the text above it moves, and goes away when the editor does. None of
 * that is worth rebuilding, and all of it is in `editor/contrib/zoneWidget`
 * with nothing about chat attached to it.
 */

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { ZoneWidget } from '../../../../editor/contrib/zoneWidget/browser/zoneWidget.js';
import { CloudeideClient } from './cloudeideClient.js';
import { runAgentLoop } from './cloudeideAgentLoop.js';
import { buildInlineRequest, buildInlineSystemPrompt, stripFence } from './cloudeideInlinePrompt.js';
import type { AgentToolResult } from './cloudeideAgentTools.js';

const $ = DOM.$;

/** How many lines of surrounding code the model is shown either side. */
const CONTEXT_LINES = 30;

/** The box's height, in lines, while it is only asking. */
const ASKING_HEIGHT = 3;

export class CloudeideInlineEdit extends ZoneWidget {

	private input!: HTMLTextAreaElement;
	private status!: HTMLElement;
	private actions!: HTMLElement;

	private readonly run = new DisposableStore();
	private cancellation: CancellationTokenSource | undefined;

	/** Where the answer went, so Discard knows what to take back. */
	private applied: { range: Range; original: string } | undefined;

	constructor(
		editor: ICodeEditor,
		private readonly client: CloudeideClient,
		private readonly model: string,
		private readonly onClosed: () => void,
	) {
		super(editor, {
			showFrame: false,
			showArrow: false,
			isAccessible: true,
			// The selection is the subject of the sentence being written. A
			// widget that cleared it would leave the person talking about
			// something they can no longer see.
			keepEditorSelection: true,
			className: 'cloudeide-inline-zone',
		});
		this._disposables.add(this.run);
		this.create();
	}

	protected _fillContainer(container: HTMLElement): void {
		const box = DOM.append(container, $('.cloudeide-inline'));

		this.input = DOM.append(box, $('textarea.cloudeide-inline-input')) as HTMLTextAreaElement;
		this.input.rows = 1;
		this.input.placeholder = localize('cloudeide.inline.placeholder', "What should this become?");
		this.input.setAttribute('aria-label', localize('cloudeide.inline.label', "Describe the change"));

		const foot = DOM.append(box, $('.cloudeide-inline-foot'));
		this.status = DOM.append(foot, $('span.cloudeide-inline-status'));
		DOM.append(foot, $('span.cloudeide-inline-spacer'));
		this.actions = DOM.append(foot, $('.cloudeide-inline-actions'));

		const hint = DOM.append(this.actions, $('span.cloudeide-inline-hint'));
		hint.textContent = localize('cloudeide.inline.escape', "Esc");

		this.run.add(DOM.addDisposableListener(this.input, 'keydown', (e: KeyboardEvent) => {
			if (e.keyCode === KeyCode.Escape || e.key === 'Escape') {
				DOM.EventHelper.stop(e, true);
				this.dismiss();
				return;
			}
			if ((e.key === 'Enter') && !e.shiftKey) {
				DOM.EventHelper.stop(e, true);
				void this.ask();
			}
		}));
	}

	/** Opens at the selection, or at the cursor when there is none. */
	start(selection: Selection): void {
		const lines = selection.isEmpty()
			? localize('cloudeide.inline.nothingSelected', "nothing selected · it will write at the cursor")
			: this.selectedLabel(selection);
		this.status.textContent = lines;

		this.show(selection.isEmpty()
			? { lineNumber: selection.startLineNumber, column: 1 }
			: new Range(selection.endLineNumber, 1, selection.endLineNumber, 1), ASKING_HEIGHT);
		this.input.focus();
	}

	private selectedLabel(selection: Selection): string {
		const count = selection.endLineNumber - selection.startLineNumber + 1;
		return count === 1
			? localize('cloudeide.inline.oneLine', "1 line selected")
			: localize('cloudeide.inline.manyLines', "{0} lines selected", count);
	}

	private async ask(): Promise<void> {
		const instruction = this.input.value.trim();
		const textModel = this.editor.getModel();
		const selection = this.editor.getSelection();
		if (!instruction || !textModel || !selection) {
			return;
		}

		this.input.disabled = true;
		this.status.textContent = localize('cloudeide.inline.thinking', "Working…");

		/*
		 * The whole lines, not the exact selection.
		 *
		 * Somebody who drags from the middle of one line to the middle of
		 * another has selected a fragment that is not valid code on its own.
		 * Widening to line boundaries is what makes the thing sent, and the
		 * thing replaced, something a model can reason about.
		 */
		const target = selection.isEmpty()
			? new Range(selection.startLineNumber, 1, selection.startLineNumber, 1)
			: new Range(selection.startLineNumber, 1,
				selection.endLineNumber, textModel.getLineMaxColumn(selection.endLineNumber));

		const original = selection.isEmpty() ? '' : textModel.getValueInRange(target);
		const above = textModel.getValueInRange(new Range(
			Math.max(1, target.startLineNumber - CONTEXT_LINES), 1, target.startLineNumber, 1));
		const belowStart = Math.min(textModel.getLineCount(), target.endLineNumber + 1);
		const below = textModel.getValueInRange(new Range(
			belowStart, 1,
			Math.min(textModel.getLineCount(), target.endLineNumber + CONTEXT_LINES),
			textModel.getLineMaxColumn(Math.min(textModel.getLineCount(), target.endLineNumber + CONTEXT_LINES))));

		const source = new CancellationTokenSource();
		this.cancellation = source;

		let answer = '';
		try {
			await runAgentLoop({
				messages: [{
					role: 'user', content: buildInlineRequest({
						languageId: textModel.getLanguageId(),
						path: textModel.uri.path.split('/').pop() ?? textModel.uri.path,
						selection: original,
						before: above,
						after: below,
						instruction,
					}),
				}],
				// No tools at all. This is one question with one answer; a
				// loop that could call something would be a loop that could
				// take four turns to replace two lines.
				tools: [],
				toolHost: { async run(): Promise<AgentToolResult> { return { content: '' }; } },
				model: this.model,
				system: buildInlineSystemPrompt(!selection.isEmpty()),
				send: body => this.client.anthropicMessages(body),
				token: source.token,
				onEvent: event => {
					if (event.type === 'text') {
						answer += event.text;
					}
				},
				maxSteps: 1,
			});
		} catch (err) {
			this.fail(err instanceof Error ? err.message : String(err));
			return;
		} finally {
			this.cancellation = undefined;
			source.dispose();
		}

		if (source.token.isCancellationRequested) {
			return;
		}

		const replacement = stripFence(answer);
		if (!replacement.trim()) {
			this.fail(localize('cloudeide.inline.empty', "Nothing came back. Try saying it another way."));
			return;
		}

		this.apply(target, original, replacement, selection.isEmpty());
	}

	/**
	 * Puts the answer in the buffer, as one undoable step.
	 *
	 * Through `executeEdits` with an undo stop either side, so Discard is the
	 * editor's own undo rather than a second copy of the old text kept here —
	 * and so Ctrl+Z afterwards takes back the whole change rather than
	 * unpicking it a character at a time.
	 */
	private apply(target: Range, original: string, replacement: string, insert: boolean): void {
		const textModel = this.editor.getModel();
		if (!textModel) {
			return;
		}

		this.editor.pushUndoStop();
		this.editor.executeEdits('cloudeide.inlineEdit', [{
			range: insert ? new Range(target.startLineNumber, 1, target.startLineNumber, 1) : target,
			text: insert ? `${replacement}\n` : replacement,
		}]);
		this.editor.pushUndoStop();

		this.applied = { range: target, original };
		this.settleUi(replacement);
	}

	/** The box stops asking and starts offering the two decisions. */
	private settleUi(replacement: string): void {
		this.input.style.display = 'none';
		const added = replacement.split('\n').length;
		this.status.textContent = added === 1
			? localize('cloudeide.inline.done1', "1 line written")
			: localize('cloudeide.inline.doneN', "{0} lines written", added);

		DOM.clearNode(this.actions);

		const keep = DOM.append(this.actions, $('button.cloudeide-button-primary')) as HTMLButtonElement;
		keep.textContent = localize('cloudeide.inline.keep', "Keep");
		this.run.add(DOM.addDisposableListener(keep, 'click', () => this.dismiss()));

		const discard = DOM.append(this.actions, $('button.cloudeide-button-quiet')) as HTMLButtonElement;
		discard.textContent = localize('cloudeide.inline.discard', "Discard");
		this.run.add(DOM.addDisposableListener(discard, 'click', () => {
			this.editor.getModel()?.undo();
			this.dismiss();
		}));

		const again = DOM.append(this.actions, $('button.cloudeide-inline-again')) as HTMLButtonElement;
		again.textContent = localize('cloudeide.inline.again', "Again");
		again.title = localize('cloudeide.inline.againTitle', "Take it back and ask the same thing again");
		this.run.add(DOM.addDisposableListener(again, 'click', () => this.retry()));

		this._relayout(ASKING_HEIGHT);
		keep.focus();
	}

	/**
	 * Undoes the answer and asks the same question again.
	 *
	 * The first try being wrong is common and re-typing the sentence is not
	 * the interesting part of fixing it. The selection has to be put back
	 * first — applying the edit collapsed it — or the second attempt would
	 * be asked about the wrong lines.
	 */
	private retry(): void {
		const applied = this.applied;
		if (!applied) {
			return;
		}
		this.editor.getModel()?.undo();
		this.editor.setSelection(new Selection(
			applied.range.startLineNumber, 1, applied.range.endLineNumber, applied.range.endColumn));
		this.applied = undefined;

		this.input.style.display = '';
		this.input.disabled = false;
		DOM.clearNode(this.actions);
		const hint = DOM.append(this.actions, $('span.cloudeide-inline-hint'));
		hint.textContent = localize('cloudeide.inline.escape', "Esc");
		void this.ask();
	}

	private fail(message: string): void {
		this.input.disabled = false;
		this.status.textContent = message;
		this.status.classList.add('cloudeide-inline-failed');
		this.input.focus();
	}

	private dismiss(): void {
		this.cancellation?.cancel();
		this.hide();
		this.editor.focus();
		this.onClosed();
	}

	override dispose(): void {
		this.cancellation?.cancel();
		super.dispose();
	}
}

/** The icon the command shows, kept here so the contribution has one import. */
export const inlineEditIcon = Codicon.sparkle;
export const inlineEditIconClass = ThemeIcon.asClassName(Codicon.sparkle);
