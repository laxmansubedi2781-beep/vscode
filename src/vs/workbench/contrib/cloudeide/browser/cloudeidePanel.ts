/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Gesture } from '../../../../base/browser/touch.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { URI } from '../../../../base/common/uri.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CloudeideClient, type ChatMessage, type FileChange } from './cloudeideClient.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';

const $ = DOM.$;

/*
 * The sign-in contribution's command, by id rather than by import.
 *
 * That contribution is registered only in the desktop build — the flow it runs
 * ends at a cloudeide:// URL, which a web page cannot receive — and this panel
 * compiles for both. An id costs nothing when the command is absent; an import
 * would drag an electron-only surface into the web bundle.
 */
const CLOUDEIDE_SIGN_IN_COMMAND = 'cloudeide.signIn';

/**
 * The CloudeIDE panel.
 *
 * One surface, three states: connect, ask, ship. It holds a chat and a deploy
 * button and nothing else, because everything else in this window is already
 * an editor that does its job well — a panel that re-implements a file tree or
 * a terminal beside one is noise.
 *
 * The deploy button is the reason this panel exists rather than a chat
 * extension. Asking a model for a change is something several products do; the
 * same panel then putting the result on a URL is the part that is ours.
 */
export class CloudeidePanel extends ViewPane {

	static readonly ID = 'workbench.view.cloudeide';

	private readonly client: CloudeideClient;

	private root!: HTMLElement;
	private connectView!: HTMLElement;
	private mainView!: HTMLElement;
	private transcript!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private statusLine!: HTMLElement;

	private readonly messages: ChatMessage[] = [];
	private busy = false;

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.client = new CloudeideClient(secretStorageService, configurationService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.root = DOM.append(container, $('.cloudeide-panel'));

		/*
		 * Hands touch back to the browser inside this panel.
		 *
		 * The workbench installs a document-level gesture handler that calls
		 * preventDefault on touchstart to build its own tap and swipe events.
		 * That is right for a tree or a tab bar, and wrong for a text field: it
		 * cancels the tap before the browser can move the caret, so on a phone
		 * the token box could not be focused and the on-screen keyboard never
		 * came up. Nothing here needs a custom gesture — it is a form.
		 *
		 * Registered on the root, and `ignoreTarget` matches descendants, so
		 * every control inside is covered.
		 */
		this._register(Gesture.ignoreTarget(this.root));

		this.connectView = DOM.append(this.root, $('.cloudeide-connect'));
		this.mainView = DOM.append(this.root, $('.cloudeide-main'));

		this.buildConnectView();
		this.buildMainView();

		// Which half shows depends on whether a token is stored, so both are
		// built up front and one is hidden — the alternative is a visible
		// rebuild every time the panel opens.
		void this.refreshConnectionState();
	}

	// ── connect ───────────────────────────────────────────────────────────────

	private buildConnectView(): void {
		const box = DOM.append(this.connectView, $('.cloudeide-connect-box'));

		const heading = DOM.append(box, $('h2.cloudeide-heading'));
		heading.textContent = localize('cloudeide.tagline', "Ask, and it ships.");

		const blurb = DOM.append(box, $('p.cloudeide-blurb'));
		blurb.textContent = localize('cloudeide.blurb',
			"Describe a change in plain words. CloudeIDE writes it, builds it, and puts it on a live URL.");

		/*
		 * One button, and it opens the same door a first launch shows.
		 *
		 * This used to be a field asking for an API token — the flow the door
		 * replaced. Somebody who chose "Continue without signing in" and then
		 * typed a question landed here and was asked for a credential that the
		 * product had already stopped issuing by hand, which is why the panel
		 * kept answering "Not connected to CloudeIDE" with no way forward.
		 */
		const signIn = DOM.append(box, $('button.cloudeide-button-primary.cloudeide-connect-button')) as HTMLButtonElement;
		signIn.textContent = localize('cloudeide.signInHere', "Sign in");

		const error = DOM.append(box, $('p.cloudeide-error'));
		error.style.display = 'none';

		const hint = DOM.append(box, $('p.cloudeide-hint'));
		hint.textContent = localize('cloudeide.signInHint',
			"Google, GitHub or email. It opens in your browser and comes back here.");

		this._register(DOM.addDisposableListener(signIn, 'click', async () => {
			signIn.disabled = true;
			error.style.display = 'none';
			try {
				await this.commandService.executeCommand(CLOUDEIDE_SIGN_IN_COMMAND);
				// Asked rather than trusted: the door reports that it closed,
				// and the token is the only thing that settles whether anyone
				// signed in.
				await this.refreshConnectionState();
			} catch (err) {
				error.textContent = err instanceof Error ? err.message : String(err);
				error.style.display = '';
			} finally {
				signIn.disabled = false;
			}
		}));
	}

	// ── main ──────────────────────────────────────────────────────────────────

	private buildMainView(): void {
		this.mainView.style.display = 'none';

		this.transcript = DOM.append(this.mainView, $('.cloudeide-transcript'));
		this.renderEmptyTranscript();

		const composer = DOM.append(this.mainView, $('.cloudeide-composer'));

		this.input = DOM.append(composer, $('textarea.cloudeide-textarea')) as HTMLTextAreaElement;
		this.input.rows = 2;
		this.input.placeholder = localize('cloudeide.ask', "Ask CloudeIDE to change something…");
		this.input.setAttribute('aria-label', localize('cloudeide.askLabel', "Message CloudeIDE"));

		const row = DOM.append(composer, $('.cloudeide-composer-row'));

		// An arrow, not the word "Send". Sending a message is the ordinary act
		// here, and every chat the person already uses marks it with an
		// upward arrow. Deploy used to sit beside it and now lives in the
		// Cloud pane below, where the thing it produces is also shown.
		this.sendButton = DOM.append(row, $('button.cloudeide-send')) as HTMLButtonElement;
		DOM.append(this.sendButton, $(`span${ThemeIcon.asCSSSelector(Codicon.arrowUp)}`));
		const sendLabel = localize('cloudeide.send', "Send");
		this.sendButton.title = sendLabel;
		this.sendButton.setAttribute('aria-label', sendLabel);

		this.statusLine = DOM.append(this.mainView, $('.cloudeide-status'));
		this.statusLine.style.display = 'none';

		this.updateSendEnablement();
		this._register(DOM.addDisposableListener(this.input, 'input', () => this.updateSendEnablement()));
		this._register(DOM.addDisposableListener(this.sendButton, 'click', () => void this.send()));
		this._register(DOM.addDisposableListener(this.input, 'keydown', (e: KeyboardEvent) => {
			// Enter sends; Shift+Enter is a newline. The panel is for one-line
			// asks far more often than for paragraphs.
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		}));
	}

	private renderEmptyTranscript(): void {
		DOM.clearNode(this.transcript);
		const empty = DOM.append(this.transcript, $('.cloudeide-empty'));
		const heading = DOM.append(empty, $('p.cloudeide-heading-sm'));
		heading.textContent = localize('cloudeide.tagline', "Ask, and it ships.");
		const blurb = DOM.append(empty, $('p.cloudeide-blurb'));
		blurb.textContent = localize('cloudeide.emptyBlurb',
			"Describe a change. Press Deploy when you want it live.");
	}

	private async refreshConnectionState(): Promise<void> {
		const token = await this.client.getToken();
		if (!token) {
			this.showConnect();
			return;
		}
		try {
			const me = await this.client.whoami();
			this.showMain(me.email);
		} catch {
			// A token that no longer works is the same situation as no token,
			// and pretending otherwise strands the person in a chat that 401s.
			await this.client.clearToken();
			this.showConnect();
		}
	}

	private showConnect(): void {
		this.connectView.style.display = '';
		this.mainView.style.display = 'none';
	}

	private showMain(email: string): void {
		this.connectView.style.display = 'none';
		this.mainView.style.display = '';
		this.setStatus(localize('cloudeide.signedIn', "Connected as {0}", email), 'muted');
	}

	// ── actions ───────────────────────────────────────────────────────────────

	private setStatus(text: string, tone: 'muted' | 'error' | 'ok', href?: string): void {
		DOM.clearNode(this.statusLine);
		this.statusLine.style.display = '';
		this.statusLine.className = `cloudeide-status cloudeide-status-${tone}`;

		if (href) {
			const link = DOM.append(this.statusLine, $('a.cloudeide-link')) as HTMLAnchorElement;
			link.textContent = text;
			this._register(DOM.addDisposableListener(link, 'click', () => {
				this.openerService.open(URI.parse(href));
			}));
		} else {
			this.statusLine.textContent = text;
		}
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.input.disabled = busy;
		this.updateSendEnablement();
	}

	/** The arrow is live only when there is something to send. */
	private updateSendEnablement(): void {
		this.sendButton.disabled = this.busy || this.input.value.trim().length === 0;
	}

	private appendTurn(role: 'user' | 'assistant', text: string): HTMLElement {
		if (this.messages.length === 0) {
			DOM.clearNode(this.transcript);
		}
		const turn = DOM.append(this.transcript, $(`.cloudeide-turn.cloudeide-turn-${role}`));
		const who = DOM.append(turn, $('.cloudeide-turn-who'));
		who.textContent = role === 'user'
			? localize('cloudeide.you', "You")
			: localize('cloudeide.assistant', "CloudeIDE");
		const body = DOM.append(turn, $('.cloudeide-turn-body'));
		body.textContent = text;
		this.transcript.scrollTop = this.transcript.scrollHeight;
		return body;
	}

	/**
	 * What the person is looking at, written for the model to read.
	 *
	 * Without this the panel was asking about code it had never sent. Filmed,
	 * the answer said so in as many words — "I don't have access to your
	 * menu.js file... would you like to paste it?" — while the file sat open
	 * two inches to the left. The page's claim is that the agent reads your
	 * real code; this is the part that makes it one.
	 *
	 * Read from the model rather than from disk, because the editor's copy is
	 * the one being asked about: an unsaved buffer, or a file that has never
	 * been saved at all, has nothing on disk to read.
	 */
	private async gatherContext(): Promise<string | undefined> {
		// Budgets, not guesses at what matters. The file in front of the
		// person gets most of the room; the others are there so the model
		// knows they exist and can ask about them.
		const ACTIVE_LIMIT = 60_000;
		const OTHER_LIMIT = 8_000;
		const MAX_OTHERS = 5;

		const describe = (uri: URI): string | undefined => {
			const model = this.modelService.getModel(uri);
			return model?.getValue();
		};

		const label = (uri: URI): string => {
			const folder = this.contextService.getWorkspaceFolder(uri);
			if (!folder) {
				return uri.scheme === 'untitled' ? uri.path : uri.fsPath;
			}
			const base = folder.uri.path.endsWith('/') ? folder.uri.path : `${folder.uri.path}/`;
			return uri.path.startsWith(base) ? uri.path.slice(base.length) : uri.path;
		};

		const clip = (text: string, limit: number): string =>
			text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;

		const sections: string[] = [];
		const seen = new Set<string>();

		const active = this.editorService.activeEditor?.resource;
		if (active) {
			const text = describe(active);
			if (text !== undefined) {
				seen.add(active.toString());
				sections.push(
					`The file the person is currently looking at is ${label(active)}:\n\n\`\`\`\n${clip(text, ACTIVE_LIMIT)}\n\`\`\``,
				);
			}
		}

		const others: string[] = [];
		for (const editor of this.editorService.editors) {
			if (others.length >= MAX_OTHERS) {
				break;
			}
			const uri = editor.resource;
			if (!uri || seen.has(uri.toString())) {
				continue;
			}
			const text = describe(uri);
			if (text === undefined) {
				continue;
			}
			seen.add(uri.toString());
			others.push(`${label(uri)}:\n\n\`\`\`\n${clip(text, OTHER_LIMIT)}\n\`\`\``);
		}
		if (others.length > 0) {
			sections.push(`Also open in the editor:\n\n${others.join('\n\n')}`);
		}

		if (sections.length === 0) {
			return undefined;
		}

		return [
			'You are CloudeIDE, helping inside the editor the person is working in.',
			'The files below are what they have open right now. Answer about this code rather than asking them to paste it.',
			...sections,
		].join('\n\n');
	}

	private async send(): Promise<void> {
		const text = this.input.value.trim();
		if (!text || this.busy) {
			return;
		}

		this.appendTurn('user', text);
		this.messages.push({ role: 'user', content: text });
		this.input.value = '';
		this.setBusy(true);

		const pending = this.appendTurn('assistant', localize('cloudeide.thinking', "Thinking…"));

		// Gathered per turn rather than once: the person may have opened,
		// edited or switched files since the last question, and stale context
		// is worse than none.
		const context = await this.gatherContext();

		let started = false;
		let reply = '';
		let runId: string | undefined;

		try {
			await this.client.agent(this.messages, event => {
				switch (event.type) {
					case 'run':
						runId = event.runId;
						break;

					case 'step':
						// The run is minutes long and mostly silent otherwise.
						// Showing each tool as it happens is the difference
						// between working and hung.
						this.appendStep(event.summary || event.tool, event.path);
						break;

					case 'text':
						if (!started) {
							pending.textContent = '';
							started = true;
						}
						reply += event.text;
						pending.textContent = reply;
						this.transcript.scrollTop = this.transcript.scrollHeight;
						break;

					case 'usage':
						this.setStatus(localize(
							'cloudeide.usage', "{0} credits · {1} steps", event.creditsSpent, event.steps,
						), 'muted');
						break;

					case 'proposal':
						if (event.changes.length > 0) {
							this.appendProposal(event.runId, event.changes);
						}
						break;

					case 'done':
						if (event.status === 'limit-reached') {
							this.setStatus(event.reason ?? localize('cloudeide.limit', "Run stopped at its limit."), 'error');
						}
						break;
				}
			}, {
				system: context,
				// The agent may change files. That is the point of this route,
				// and the proposal is where the person gets a say.
				allowWrites: true,
			});

			if (!started) {
				pending.textContent = reply || localize('cloudeide.noAnswer', "The run finished without an answer.");
			}
			if (reply) {
				this.messages.push({ role: 'assistant', content: reply });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			pending.textContent = message;
			pending.classList.add('cloudeide-turn-failed');
			// Dropped from history: sending a failed turn back on the next
			// request would have the model answering an error message.
			this.messages.pop();
			this.setStatus(message, 'error');
		} finally {
			this.setBusy(false);
			this.input.focus();
		}

		// Mentioned only so the unused-variable rule does not hide a real bug
		// later: the run id travels on the proposal, which carries its own.
		void runId;
	}

	/** One line per tool the run used, as it uses it. */
	private appendStep(summary: string, path?: string): void {
		const line = DOM.append(this.transcript, $('.cloudeide-step'));
		line.textContent = path ? `${summary} — ${path}` : summary;
		this.transcript.scrollTop = this.transcript.scrollHeight;
	}

	/**
	 * What the run wants to change, and the two buttons that decide it.
	 *
	 * Nothing has been written at this point. The server stages the changes
	 * and sends both sides of every file; applying them is this editor's job,
	 * and the person's call.
	 */
	private appendProposal(runId: string, changes: readonly FileChange[]): void {
		const card = DOM.append(this.transcript, $('.cloudeide-proposal'));

		const head = DOM.append(card, $('.cloudeide-proposal-head'));
		head.textContent = changes.length === 1
			? localize('cloudeide.proposal.one', "1 file to change")
			: localize('cloudeide.proposal.many', "{0} files to change", changes.length);

		for (const change of changes) {
			const row = DOM.append(card, $('button.cloudeide-proposal-file')) as HTMLButtonElement;
			const twisty = DOM.append(row, $('span.cloudeide-proposal-twisty'));
			twisty.textContent = '\u203A';
			const kind = DOM.append(row, $(`span.cloudeide-proposal-kind.cloudeide-proposal-${change.kind}`));
			kind.textContent = change.kind;
			const name = DOM.append(row, $('span.cloudeide-proposal-path'));
			name.textContent = change.path;

			const counts = countChangedLines(change);
			if (counts.added > 0 || counts.removed > 0) {
				const tally = DOM.append(row, $('span.cloudeide-proposal-tally'));
				if (counts.added > 0) {
					DOM.append(tally, $('span.cloudeide-proposal-added')).textContent = `+${counts.added}`;
				}
				if (counts.removed > 0) {
					DOM.append(tally, $('span.cloudeide-proposal-removed')).textContent = `-${counts.removed}`;
				}
			}

			// The diff is built on first open rather than up front: a proposal
			// touching a dozen large files would otherwise pay for twelve
			// diffs the person may never look at.
			const body = DOM.append(card, $('.cloudeide-proposal-diff'));
			body.style.display = 'none';
			let filled = false;
			this._register(DOM.addDisposableListener(row, 'click', () => {
				const open = body.style.display === 'none';
				if (open && !filled) {
					renderDiff(body, change);
					filled = true;
				}
				body.style.display = open ? '' : 'none';
				row.classList.toggle('cloudeide-proposal-open', open);
			}));
		}

		const actions = DOM.append(card, $('.cloudeide-proposal-actions'));
		const accept = DOM.append(actions, $('button.cloudeide-button-primary')) as HTMLButtonElement;
		accept.textContent = localize('cloudeide.proposal.accept', "Apply");
		const discard = DOM.append(actions, $('button.cloudeide-button-quiet')) as HTMLButtonElement;
		discard.textContent = localize('cloudeide.proposal.discard', "Discard");

		const settle = (verdict: string) => {
			accept.remove();
			discard.remove();
			const done = DOM.append(actions, $('span.cloudeide-proposal-settled'));
			done.textContent = verdict;
		};

		this._register(DOM.addDisposableListener(accept, 'click', async () => {
			accept.disabled = true;
			discard.disabled = true;
			try {
				const written = await this.applyChanges(changes);
				await this.client.decideProposal(runId, 'applied');
				settle(localize('cloudeide.proposal.applied', "Applied to {0} files", written));
			} catch (err) {
				accept.disabled = false;
				discard.disabled = false;
				this.setStatus(err instanceof Error ? err.message : String(err), 'error');
			}
		}));

		this._register(DOM.addDisposableListener(discard, 'click', async () => {
			accept.disabled = true;
			discard.disabled = true;
			// Reported even though nothing was written: the server holds the
			// proposal open until it hears, and a recap that still lists a
			// discarded file as pending is a recap that lies.
			await this.client.decideProposal(runId, 'discarded').catch(() => { /* best effort */ });
			settle(localize('cloudeide.proposal.discarded', "Discarded"));
		}));

		this.transcript.scrollTop = this.transcript.scrollHeight;
	}

	/**
	 * Writes an accepted proposal to disk.
	 *
	 * Paths arrive relative to the workspace root, which is the only place
	 * they are allowed to land: a path that climbs out of it is refused rather
	 * than written, because a run that asks to edit something outside the
	 * folder the person opened is either confused or hostile.
	 */
	private async applyChanges(changes: readonly FileChange[]): Promise<number> {
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			throw new Error(localize('cloudeide.proposal.noFolder', "Open a folder before applying changes."));
		}
		const root = folders[0].uri;

		let written = 0;
		for (const change of changes) {
			const target = root.with({ path: `${root.path.replace(/\/+$/, '')}/${change.path}` });
			if (!target.path.startsWith(`${root.path.replace(/\/+$/, '')}/`)) {
				throw new Error(localize('cloudeide.proposal.outside', "Refused to write outside the folder: {0}", change.path));
			}

			if (change.kind === 'delete') {
				await this.fileService.del(target, { useTrash: true }).catch(() => { /* already gone */ });
			} else {
				await this.fileService.writeFile(target, VSBuffer.fromString(change.after ?? ''));
			}
			written++;
		}
		return written;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}
}

/** Splits a file's contents the way the diff computer wants it. */
function toLines(text: string | null): string[] {
	return text === null || text === '' ? [] : text.split(/\r\n|\r|\n/);
}

const DIFF_OPTIONS = {
	ignoreTrimWhitespace: false,
	// A proposal card is not worth stalling the panel for. Past this the
	// computer returns an approximation, which is still a fair summary of what
	// the run wants to do.
	maxComputationTimeMs: 1000,
	computeMoves: false,
};

/** How many lines a change adds and removes, for the tally beside its name. */
function countChangedLines(change: FileChange): { added: number; removed: number } {
	const before = toLines(change.before);
	const after = toLines(change.after);
	if (change.kind === 'create') {
		return { added: after.length, removed: 0 };
	}
	if (change.kind === 'delete') {
		return { added: 0, removed: before.length };
	}

	const diff = linesDiffComputers.getDefault().computeDiff(before, after, DIFF_OPTIONS);
	let added = 0;
	let removed = 0;
	for (const mapping of diff.changes) {
		removed += mapping.original.endLineNumberExclusive - mapping.original.startLineNumber;
		added += mapping.modified.endLineNumberExclusive - mapping.modified.startLineNumber;
	}
	return { added, removed };
}

/** Lines of context kept either side of a hunk. */
const DIFF_CONTEXT = 3;

/** The most lines one file's diff will draw before it stops and says so. */
const DIFF_MAX_LINES = 240;

/**
 * Draws a unified diff of one proposed change into `target`.
 *
 * This is deliberately a read-only summary and not an editor: the person is
 * deciding whether to let the run write, and a card they can type into would
 * invite edits that the Apply below it would then throw away.
 */
function renderDiff(target: HTMLElement, change: FileChange): void {
	const before = toLines(change.before);
	const after = toLines(change.after);

	let drawn = 0;
	const line = (kind: 'add' | 'del' | 'ctx' | 'meta', text: string) => {
		if (drawn >= DIFF_MAX_LINES) {
			return false;
		}
		const el = DOM.append(target, $(`.cloudeide-diff-line.cloudeide-diff-${kind}`));
		// A zero-width space keeps an empty line's height without a &nbsp;.
		el.textContent = text === '' ? '​' : text;
		drawn++;
		return true;
	};

	if (change.kind === 'create' || change.kind === 'delete') {
		const kind = change.kind === 'create' ? 'add' : 'del';
		const sign = change.kind === 'create' ? '+' : '-';
		const body = change.kind === 'create' ? after : before;
		for (const text of body) {
			if (!line(kind, `${sign}${text}`)) {
				break;
			}
		}
	} else {
		const diff = linesDiffComputers.getDefault().computeDiff(before, after, DIFF_OPTIONS);
		let cursor = 1; // 1-based, in the original file
		let stopped = false;

		for (const mapping of diff.changes) {
			if (stopped) {
				break;
			}
			const from = Math.max(cursor, mapping.original.startLineNumber - DIFF_CONTEXT);
			if (from > cursor) {
				if (!line('meta', '⋯')) {
					stopped = true;
					break;
				}
			}
			for (let n = from; n < mapping.original.startLineNumber; n++) {
				if (!line('ctx', ` ${before[n - 1]}`)) {
					stopped = true;
					break;
				}
			}
			for (let n = mapping.original.startLineNumber; !stopped && n < mapping.original.endLineNumberExclusive; n++) {
				if (!line('del', `-${before[n - 1]}`)) {
					stopped = true;
				}
			}
			for (let n = mapping.modified.startLineNumber; !stopped && n < mapping.modified.endLineNumberExclusive; n++) {
				if (!line('add', `+${after[n - 1]}`)) {
					stopped = true;
				}
			}
			const until = Math.min(before.length + 1, mapping.original.endLineNumberExclusive + DIFF_CONTEXT);
			for (let n = mapping.original.endLineNumberExclusive; !stopped && n < until; n++) {
				if (!line('ctx', ` ${before[n - 1]}`)) {
					stopped = true;
				}
			}
			cursor = until;
		}

		if (diff.changes.length === 0) {
			line('meta', localize('cloudeide.diff.same', "No change to this file."));
		}
	}

	if (drawn >= DIFF_MAX_LINES) {
		const more = DOM.append(target, $('.cloudeide-diff-line.cloudeide-diff-meta'));
		more.textContent = localize('cloudeide.diff.truncated', "Diff shortened — open the file after applying to see all of it.");
	}
}
