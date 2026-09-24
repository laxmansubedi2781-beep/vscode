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
import { collectWorkspaceFiles, toWorkspaceState } from './cloudeideWorkspace.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { CloudeideCommandRunner, type CommandRunResult, type IAgentCommandRunner } from './cloudeideAgentCommand.js';
import { CloudeideAppliedMarks } from './cloudeideAppliedMarks.js';
import { CloudeideEditPreview, type PreviewedFile } from './cloudeideEditPreview.js';
import { CloudeideHistory, historyFileUri, type HistoryRun } from './cloudeideHistory.js';
import { CloudeideMentions, mentionNote, mentionedFiles } from './cloudeideMentions.js';
import { AGENT_MODES, modeById, toolsForMode, type AgentMode } from './cloudeideModes.js';
import { CloudeidePullRequests, describeChange } from './cloudeidePullRequest.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { CloudeideAgentTools, type StagedEdit } from './cloudeideAgentTools.js';
import { runAgentLoop } from './cloudeideAgentLoop.js';
import { buildAgentSystemPrompt } from './cloudeideAgentPrompt.js';

const $ = DOM.$;

/*
 * The sign-in contribution's command, by id rather than by import.
 *
 * That contribution is registered only in the desktop build — the flow it runs
 * ends at a cloudeide:// URL, which a web page cannot receive — and this panel
 * compiles for both. An id costs nothing when the command is absent; an import
 * would drag an electron-only surface into the web bundle.
 */
const CLOUDEIDE_MODEL_SETTING = 'cloudeide.model';

/**
 * What the agent runs on unless the account says otherwise.
 *
 * Sonnet rather than the cheapest or the most capable: a coding turn is a
 * loop of tool calls, and the difference between models shows up as how many
 * of them it takes to get somewhere — which is also what it costs.
 */
const DEFAULT_AGENT_MODEL = 'claude-sonnet-5';

/** How much of a project's instructions file is read into the prompt. */
const MAX_PROJECT_RULES_CHARS = 16 * 1024;

/**
 * A tool call in a few words, for the line the person watches go by.
 *
 * Named after what it did to their project, not after the tool: "Reading
 * src/menu.js" rather than "read_file". The path travels separately so the
 * line can show it quietly beside the summary.
 */
function describeTool(name: string, input: Record<string, unknown>): string {
	const query = typeof input.query === 'string' ? input.query : '';
	const symbol = typeof input.name === 'string' ? input.name : '';
	switch (name) {
		case 'list_files': return localize('cloudeide.tool.list', "Looking through the project");
		case 'read_file': return localize('cloudeide.tool.read', "Reading");
		case 'search_files': return localize('cloudeide.tool.search', "Searching for {0}", query);
		case 'edit_file': return localize('cloudeide.tool.edit', "Editing");
		case 'find_symbol': return localize('cloudeide.tool.symbol', "Finding where {0} is declared", symbol);
		case 'find_references': return localize('cloudeide.tool.references', "Finding what uses {0}", symbol);
		case 'run_command': return localize('cloudeide.tool.run', "Ran {0}", typeof input.command === 'string' ? input.command : '');
		case 'ask_user': return localize('cloudeide.tool.ask', "Asking");
		case 'get_diagnostics': return localize('cloudeide.tool.diagnostics', "Checking for errors");
		case 'write_file': return localize('cloudeide.tool.write', "Writing");
		default: return name;
	}
}

function toolPath(input: Record<string, unknown>): string | undefined {
	return typeof input.path === 'string' ? input.path : undefined;
}

/**
 * A staged edit as the proposal card wants it.
 *
 * `before === undefined` is a file that does not exist yet, which the card
 * calls a create; the card's own type says `null` for the same thing.
 */
function toFileChange(edit: StagedEdit): FileChange {
	return {
		path: edit.path,
		kind: edit.before === undefined ? 'create' : 'edit',
		before: edit.before ?? null,
		after: edit.after,
	};
}

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

	/** The last state uploaded, so an unchanged project is not sent twice. */
	private syncedState: string | undefined;

	/** The run in flight, so disposing the panel stops it. */
	private runCancellation: CancellationTokenSource | undefined;
	/** Built on first use and kept, so the agent's shell survives the turn. */
	private runner: IAgentCommandRunner | undefined;
	private modelButton!: HTMLButtonElement;
	/** The question that started the run now in flight. */
	private lastAsk = '';
	/** What the agent last said, used to title a pull request. */
	private lastReply = '';
	private historyStrip!: HTMLElement;
	private mentions!: CloudeideMentions;
	private modeButton!: HTMLButtonElement;
	/** What the next turn is for. Kept here, not in settings: it changes per question. */
	private mode: AgentMode = 'agent';
	/** Getting a run's work off this machine. Built on first use: the client is not ready at field time. */
	private pullRequestsValue: CloudeidePullRequests | undefined;
	/** The last run's reply and files, for the pull request that may follow it. */
	private lastRun: { reply: string; files: string[] } | undefined;
	/** The green and red marks left on whatever the last Apply wrote. */
	private readonly appliedMarks = this._register(new CloudeideAppliedMarks(this.textModelService));
	/** Where a run's change lands, and what Keep and Undo act on. */
	private readonly preview = this._register(this.instantiationService.createInstance(CloudeideEditPreview, this.appliedMarks));
	/** What the agent has done in this folder, across windows. */
	private readonly history = this._register(this.instantiationService.createInstance(CloudeideHistory));

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
		@ISearchService private readonly searchService: ISearchService,
		@IMarkerService private readonly markerService: IMarkerService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.client = new CloudeideClient(secretStorageService, configurationService);

		// A run outlives the panel otherwise: the loop would go on calling
		// tools against a workspace nobody is watching, and paying for it.
		this._register(toDisposable(() => this.runCancellation?.cancel()));
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

		// No heading, no tagline. Somebody looking at this has already chosen
		// the product and installed it; a slogan here is an advertisement
		// shown to a customer, and all it does is stand between them and the
		// one button that matters.

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

		this.historyStrip = DOM.append(this.mainView, $('.cloudeide-history'));
		this.transcript = DOM.append(this.mainView, $('.cloudeide-transcript'));
		this.renderEmptyTranscript();
		this.renderHistory();

		const composer = DOM.append(this.mainView, $('.cloudeide-composer'));

		this.input = DOM.append(composer, $('textarea.cloudeide-textarea')) as HTMLTextAreaElement;
		this.input.rows = 2;
		this.input.placeholder = localize('cloudeide.ask', "Ask for a change…");
		this.input.setAttribute('aria-label', localize('cloudeide.askLabel', "Ask for a change"));

		this.mentions = this._register(new CloudeideMentions(
			composer, this.input, this.contextService, this.searchService,
			this.instantiationService.createInstance(QueryBuilder)));

		const row = DOM.append(composer, $('.cloudeide-composer-row'));

		/*
		 * Which model, next to the thing you are about to send.
		 *
		 * It was in Settings, which is the right place to store it and the
		 * wrong place to change it: nobody opens Settings mid-thought to move
		 * one question onto a bigger model. The button is quiet — it is a
		 * label most of the time — and pressing it opens the workbench's own
		 * quick pick rather than a menu built here.
		 */
		/*
		 * What this turn is for, in front of what it runs on.
		 *
		 * Left of the model because it is the bigger decision: which model
		 * answers matters less than whether the answer is allowed to change
		 * anything.
		 */
		this.modeButton = DOM.append(row, $('button.cloudeide-mode')) as HTMLButtonElement;
		this.updateModeLabel();
		this._register(DOM.addDisposableListener(this.modeButton, 'click', () => void this.pickMode()));

		this.modelButton = DOM.append(row, $('button.cloudeide-model')) as HTMLButtonElement;
		this.updateModelLabel();
		this._register(DOM.addDisposableListener(this.modelButton, 'click', () => void this.pickModel()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CLOUDEIDE_MODEL_SETTING)) {
				this.updateModelLabel();
			}
		}));

		DOM.append(row, $('span.cloudeide-composer-spacer'));

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
			// The file list gets the key first when it is open, or Enter
			// sends the message instead of choosing the file somebody was
			// half-way through picking.
			if (this.mentions.handleKey(e)) {
				DOM.EventHelper.stop(e, true);
				return;
			}

			// Enter sends; Shift+Enter is a newline. The panel is for one-line
			// asks far more often than for paragraphs.
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		}));
	}

	/**
	 * An empty transcript is left empty.
	 *
	 * It held a tagline and a line of instructions. Neither was read twice:
	 * the box underneath already says what to type, and the second line told
	 * people to press a Deploy button that is no longer on this panel.
	 */
	/**
	 * Earlier runs, as one line until somebody wants them.
	 *
	 * A list of past work permanently open at the top of a panel this narrow
	 * would push the thing people came for — the box — off the bottom of the
	 * screen. So it is a line, and it is only there at all when there is
	 * something to show.
	 *
	 * Rows are not clickable as a whole, because there is nothing to reopen:
	 * the conversation is not kept. The files are, and each one opens.
	 */
	private renderHistory(): void {
		DOM.clearNode(this.historyStrip);
		const runs = this.history.read();
		if (runs.length === 0) {
			this.historyStrip.style.display = 'none';
			return;
		}
		this.historyStrip.style.display = '';

		const toggle = DOM.append(this.historyStrip, $('button.cloudeide-history-toggle')) as HTMLButtonElement;
		const twisty = DOM.append(toggle, $('span.cloudeide-history-twisty'));
		twisty.textContent = '\u203A';
		const label = DOM.append(toggle, $('span'));
		label.textContent = runs.length === 1
			? localize('cloudeide.history.one', "1 earlier run")
			: localize('cloudeide.history.many', "{0} earlier runs", runs.length);

		const list = DOM.append(this.historyStrip, $('.cloudeide-history-list'));
		list.style.display = 'none';

		let filled = false;
		this._register(DOM.addDisposableListener(toggle, 'click', () => {
			const open = list.style.display === 'none';
			if (open && !filled) {
				for (const run of runs) {
					this.renderHistoryRun(list, run);
				}
				filled = true;
			}
			list.style.display = open ? '' : 'none';
			toggle.classList.toggle('cloudeide-history-open', open);
		}));
	}

	private renderHistoryRun(list: HTMLElement, run: HistoryRun): void {
		const item = DOM.append(list, $('.cloudeide-history-run'));

		const head = DOM.append(item, $('.cloudeide-history-ask'));
		head.textContent = run.ask || localize('cloudeide.history.noAsk', "(no question recorded)");
		head.title = run.ask;

		const meta = DOM.append(item, $('.cloudeide-history-meta'));
		meta.textContent = `${when(run.at)} · ${outcomeLabel(run.outcome)}`;

		const folder = this.contextService.getWorkspace().folders[0];
		for (const file of run.files) {
			const row = DOM.append(item, $('button.cloudeide-history-file')) as HTMLButtonElement;
			const name = DOM.append(row, $('span.cloudeide-history-path'));
			name.textContent = file.path;

			const tally = DOM.append(row, $('span.cloudeide-proposal-tally'));
			if (file.added > 0) {
				DOM.append(tally, $('span.cloudeide-proposal-added')).textContent = `+${file.added}`;
			}
			if (file.removed > 0) {
				DOM.append(tally, $('span.cloudeide-proposal-removed')).textContent = `\u2212${file.removed}`;
			}

			if (folder) {
				const target = historyFileUri(folder.uri, file.path);
				row.title = localize('cloudeide.history.open', "Open {0}", file.path);
				this._register(DOM.addDisposableListener(row, 'click', () => {
					// The file may be gone — undone, or deleted since. Opening
					// it then does nothing rather than throwing a dialog at
					// somebody who only wanted a look.
					void this.editorService.openEditor({ resource: target }).catch(() => { });
				}));
			}
		}
	}

	private renderEmptyTranscript(): void {
		DOM.clearNode(this.transcript);
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
			: localize('cloudeide.assistant', "Agent");
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
		// Kept for the history entry this run will write. Taken here rather
		// than from the message list, which by then holds the whole
		// conversation and not the question that started this run.
		this.lastAsk = text;
		this.input.value = '';
		this.setBusy(true);

		const pending = this.appendTurn('assistant', localize('cloudeide.thinking', "Thinking…"));

		// Gathered per turn rather than once: the person may have opened,
		// edited or switched files since the last question, and stale context
		// is worse than none.
		const context = await this.gatherContext();

		/*
		 * Files named with `@`, said plainly.
		 *
		 * The model could notice the `@` in the sentence and work out what it
		 * meant, and mostly would. Telling it outright costs one line and
		 * removes the "mostly" — which is the whole point of letting somebody
		 * name the file in the first place.
		 */
		const named = mentionNote(mentionedFiles(text));
		const withNamed = named
			? (context ? `${context}\n\n${named}` : named)
			: context;

		/*
		 * Which agent answers this.
		 *
		 * A folder open means the tools have something real to read, so the
		 * run happens here and the project never leaves the machine. With no
		 * folder — the web build, or a window opened on nothing — there is
		 * nothing for local tools to work on, and the server's agent answers
		 * from what was uploaded instead. One product, two situations, rather
		 * than a setting for the person to get wrong.
		 */
		if (this.contextService.getWorkspace().folders.length > 0) {
			try {
				const local = await this.runLocalAgent(pending, withNamed);
				if (local) {
					this.messages.push({ role: 'assistant', content: local });
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				pending.textContent = message;
				pending.classList.add('cloudeide-turn-failed');
				this.messages.pop();
				this.setStatus(message, 'error');
			} finally {
				this.setBusy(false);
				this.input.focus();
			}
			return;
		}

		// No folder: the server answers, from the copy this sends ahead of it.
		// Failure here is not fatal — the run still gets the open files in
		// `context` — so it reports and carries on rather than refusing to
		// answer a question it could have answered less well.
		await this.syncWorkspace();

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
							void this.showChanges(event.runId, event.changes);
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

	/**
	 * A turn of the agent that runs here, on this machine.
	 *
	 * The model is the only thing that leaves: the tools read and change the
	 * real files, in the folder the person has open, and nothing is uploaded.
	 * The other path — `this.client.agent` — answers from a copy of the
	 * project sent ahead of the run, which is all the web build can do and
	 * less than this one should settle for.
	 *
	 * Returns what the model said, so the caller can put it in the history.
	 */
	private async runLocalAgent(pending: HTMLElement, contextNote: string | undefined): Promise<string> {
		const tools = new CloudeideAgentTools(
			this.fileService,
			this.contextService,
			this.searchService,
			this.instantiationService.createInstance(QueryBuilder),
			this.markerService,
			this.languageFeaturesService,
			this.textModelService,
			this.commandRunner(),
			{ ask: (question, options, multiple, token) => this.askQuestion(question, options, multiple, token) },
		);

		const folder = this.contextService.getWorkspace().folders[0];
		const open = this.editorService.editors
			.map(editor => editor.resource)
			.filter((uri): uri is URI => !!uri && uri.scheme === folder.uri.scheme)
			.map(uri => uri.path.startsWith(folder.uri.path) ? uri.path.slice(folder.uri.path.length + 1) : uri.path);

		const system = buildAgentSystemPrompt({
			workspaceName: folder.name,
			openFiles: open,
			activeFile: open[0],
			projectRules: await this.readProjectRules(folder.uri),
			mode: this.mode,
		});

		const source = new CancellationTokenSource();
		this.runCancellation = source;

		const startedAt = Date.now();
		const used = new Map<string, number>();

		let reply = '';
		let started = false;
		try {
			await runAgentLoop({
				// The conversation, plus whatever the open files add. The note
				// is a user turn rather than part of the system prompt: it
				// describes this question's context, not the agent's standing
				// instructions, and it changes between turns.
				messages: contextNote
					? [...this.messages, { role: 'user' as const, content: contextNote }]
					: this.messages,
				// The fence, not a request. A mode that may not change
				// anything is not offered the tools that change things, so
				// there is nothing for the model to decide to respect.
				tools: (() => {
					const all = tools.schemas();
					const allowed = new Set(toolsForMode(this.mode, all.map(t => t.name)));
					return all.filter(t => allowed.has(t.name));
				})(),
				toolHost: tools,
				model: this.configuredModel(),
				system,
				send: body => this.client.anthropicMessages(body),
				token: source.token,
				onEvent: event => {
					switch (event.type) {
						case 'text':
							if (!started) {
								pending.textContent = '';
								started = true;
							}
							reply += event.text;
							pending.textContent = reply;
							this.transcript.scrollTop = this.transcript.scrollHeight;
							break;

						case 'toolStart':
							used.set(event.name, (used.get(event.name) ?? 0) + 1);
							this.appendStep(describeTool(event.name, event.input), toolPath(event.input));
							break;

						case 'toolEnd':
							// Only failures. A line per tool is already shown
							// when it starts; repeating it on success turns the
							// transcript into a log nobody reads.
							if (event.result.isError) {
								this.appendStep(localize('cloudeide.toolFailed', "That did not work"), event.result.content);
							}
							break;

						case 'done':
							if (event.reason === 'stepLimit') {
								this.setStatus(localize('cloudeide.stepLimit',
									"The run stopped at its step limit. Ask again with a smaller piece of the task."), 'error');
							}
							break;
					}
				},
			});
		} finally {
			this.runCancellation = undefined;
			source.dispose();
		}

		const edits = tools.edits();
		if (edits.length > 0) {
			await this.showChanges(undefined, edits.map(toFileChange));
		}

		if (!started) {
			pending.textContent = reply || localize('cloudeide.noAnswer', "The run finished without an answer.");
		}

		this.appendSummary(used, Date.now() - startedAt);
		this.lastReply = reply;
		return reply;
	}

	/**
	 * One line at the end saying what the run actually did.
	 *
	 * The steps scroll past while a run is going and nobody reads them all;
	 * what is left afterwards is a wall of lines and no sense of whether that
	 * was a lot of work or a little. A total answers it in a glance, and the
	 * time is there because "why did that take so long" is the next question
	 * and the transcript never answered it.
	 *
	 * Nothing when the run used no tools. A question answered from the
	 * conversation did not read anything, and "0 files" is noise.
	 */
	private appendSummary(used: ReadonlyMap<string, number>, elapsedMs: number): void {
		const count = (...names: string[]) => names.reduce((n, name) => n + (used.get(name) ?? 0), 0);

		const parts: string[] = [];
		const read = count('read_file');
		const searched = count('search_files', 'find_symbol', 'find_references', 'list_files');
		const changed = count('edit_file', 'write_file');
		const ran = count('run_command');

		if (read > 0) {
			parts.push(read === 1
				? localize('cloudeide.summary.read1', "read 1 file")
				: localize('cloudeide.summary.readN', "read {0} files", read));
		}
		if (searched > 0) {
			parts.push(searched === 1
				? localize('cloudeide.summary.search1', "1 search")
				: localize('cloudeide.summary.searchN', "{0} searches", searched));
		}
		if (changed > 0) {
			parts.push(changed === 1
				? localize('cloudeide.summary.changed1', "changed 1 file")
				: localize('cloudeide.summary.changedN', "changed {0} files", changed));
		}
		if (ran > 0) {
			parts.push(ran === 1
				? localize('cloudeide.summary.ran1', "1 command")
				: localize('cloudeide.summary.ranN', "{0} commands", ran));
		}
		if (parts.length === 0) {
			return;
		}

		const line = DOM.append(this.transcript, $('.cloudeide-summary'));
		line.textContent = localize('cloudeide.summary', "{0} · {1}", parts.join(' · '), elapsed(elapsedMs));
		this.transcript.scrollTop = this.transcript.scrollHeight;
	}

	private get pullRequests(): CloudeidePullRequests {
		if (!this.pullRequestsValue) {
			this.pullRequestsValue = this._register(
				new CloudeidePullRequests(this.client, this.fileService, this.contextService));
		}
		return this.pullRequestsValue;
	}

	/**
	 * Offers to put the last run on GitHub.
	 *
	 * Shown after a run that changed files, not after every run: a question
	 * that asks about nothing is a question people learn to dismiss without
	 * reading, and then the one that mattered goes with it.
	 */
	/** The command's way in. Everything it needs is on this view. */
	async offerPullRequestFromCommand(): Promise<void> {
		await this.offerPullRequest();
	}

	private async offerPullRequest(): Promise<void> {
		const run = this.lastRun;
		const folders = this.contextService.getWorkspace().folders;
		if (!run || run.files.length === 0 || folders.length === 0) {
			this.setStatus(localize('cloudeide.pr.nothing',
				"Nothing to open a pull request for yet."), 'muted');
			return;
		}

		// Asked before the card is drawn. "Open PR" that answers "connect
		// GitHub first" is a button that should have said so while there was
		// still time to do something about it.
		const connection = await this.pullRequests.connected();
		if (!connection.ok) {
			this.setStatus(connection.why ?? localize('cloudeide.pr.noGithub', "GitHub is not connected."), 'error');
			return;
		}

		let repos: { label: string; base: string }[];
		try {
			repos = await this.pullRequests.repos();
		} catch (err) {
			this.setStatus(err instanceof Error ? err.message : String(err), 'error');
			return;
		}
		if (repos.length === 0) {
			this.setStatus(localize('cloudeide.pr.noRepos',
				"That GitHub account has no repositories this can push to."), 'error');
			return;
		}

		const picked = await this.quickInputService.pick(
			repos.map(r => ({ label: r.label, description: r.base, base: r.base })),
			{ placeHolder: localize('cloudeide.pr.pickRepo', "Which repository?") });
		if (!picked) {
			return;
		}

		const described = describeChange(run.reply, run.files);
		this.appendPullRequestCard(picked.label, picked.base, described, run.files);
	}

	private appendPullRequestCard(repo: string, base: string, described: { title: string; message: string }, files: readonly string[]): void {
		const card = DOM.append(this.transcript, $('.cloudeide-proposal'));

		const head = DOM.append(card, $('.cloudeide-proposal-head'));
		head.textContent = localize('cloudeide.pr.head', "Open a pull request?");

		const title = DOM.append(card, $('.cloudeide-pr-title'));
		title.textContent = described.title;

		const where = DOM.append(card, $('.cloudeide-pr-where'));
		where.textContent = localize('cloudeide.pr.where', "{0} · a new branch → {1}", repo, base);

		for (const path of files) {
			const row = DOM.append(card, $('.cloudeide-pr-file'));
			row.textContent = path;
		}

		const actions = DOM.append(card, $('.cloudeide-proposal-actions'));
		const go = DOM.append(actions, $('button.cloudeide-button-primary')) as HTMLButtonElement;
		go.textContent = localize('cloudeide.pr.open', "Open PR");
		const no = DOM.append(actions, $('button.cloudeide-button-quiet')) as HTMLButtonElement;
		no.textContent = localize('cloudeide.pr.no', "Not now");

		const settle = (verdict: string, href?: string) => {
			go.remove();
			no.remove();
			const done = DOM.append(actions, $('span.cloudeide-proposal-settled'));
			if (href) {
				const link = DOM.append(done, $('a.cloudeide-cloud-link')) as HTMLAnchorElement;
				link.textContent = verdict;
				link.href = href;
				this._register(DOM.addDisposableListener(link, 'click', event => {
					DOM.EventHelper.stop(event, true);
					void this.openerService.open(URI.parse(href));
				}));
			} else {
				done.textContent = verdict;
			}
		};

		this._register(DOM.addDisposableListener(go, 'click', async () => {
			go.disabled = true;
			no.disabled = true;
			try {
				/*
				 * The whole folder, not only what the agent touched.
				 *
				 * A pull request is a statement about the state of a branch,
				 * not a patch. A branch built from four files would delete
				 * every file the person did not happen to have the agent edit.
				 */
				const folder = this.contextService.getWorkspace().folders[0];
				const collected = await this.pullRequests.collect(folder.uri, CancellationToken.None);
				const opened = await this.pullRequests.open({
					repo, base, title: described.title, message: described.message, files: collected,
				});
				settle(localize('cloudeide.pr.opened', "{0}#{1} opened", repo, opened.number), opened.url);
			} catch (err) {
				go.disabled = false;
				no.disabled = false;
				this.setStatus(err instanceof Error ? err.message : String(err), 'error');
			}
		}));

		this._register(DOM.addDisposableListener(no, 'click',
			() => settle(localize('cloudeide.pr.notNow', "Not now"))));

		this.transcript.scrollTop = this.transcript.scrollHeight;
	}

	private updateModeLabel(): void {
		const found = AGENT_MODES.find(m => m.id === this.mode) ?? AGENT_MODES[0];
		this.modeButton.textContent = found.label;
		this.modeButton.title = found.detail;
		this.modeButton.setAttribute('aria-label',
			localize('cloudeide.mode.current', "Mode: {0}. Press to change.", found.label));
		// Plan and Ask cannot change anything, and the composer should look
		// different when that is true — otherwise somebody types a change,
		// presses send, and gets a paragraph.
		this.modeButton.classList.toggle('cloudeide-mode-readonly', this.mode !== 'agent');
	}

	private async pickMode(): Promise<void> {
		const picked = await this.quickInputService.pick(
			AGENT_MODES.map(m => ({
				label: m.label,
				detail: m.detail,
				id: m.id,
				description: m.id === this.mode ? localize('cloudeide.mode.inUse', "in use") : undefined,
			})),
			{ placeHolder: localize('cloudeide.mode.placeholder', "What is this turn for?") });
		if (!picked) {
			return;
		}
		this.mode = modeById(picked.id);
		this.updateModeLabel();
		this.input.focus();
	}

	/**
	 * The models this product offers, read from the setting that declares them.
	 *
	 * Not a second list kept here. The setting's `enum` and
	 * `enumDescriptions` are already the answer to "which models, and what is
	 * each one for", and a copy in this file would be a copy that drifts —
	 * which is how a picker ends up offering a model the server stopped
	 * accepting.
	 */
	private availableModels(): { id: string; detail?: string }[] {
		const schema = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
			.getConfigurationProperties()[CLOUDEIDE_MODEL_SETTING];
		const ids = Array.isArray(schema?.enum) ? schema.enum.filter((v): v is string => typeof v === 'string') : [];
		const details = Array.isArray(schema?.enumDescriptions) ? schema.enumDescriptions : [];
		return ids.map((id, i) => ({ id, detail: typeof details[i] === 'string' ? details[i] : undefined }));
	}

	private updateModelLabel(): void {
		const model = this.configuredModel();
		this.modelButton.textContent = model;
		this.modelButton.title = localize('cloudeide.model.pick', "Which model the agent runs on");
		this.modelButton.setAttribute('aria-label',
			localize('cloudeide.model.current', "Model: {0}. Press to change.", model));
	}

	private async pickModel(): Promise<void> {
		const current = this.configuredModel();
		const picked = await this.quickInputService.pick(
			this.availableModels().map(m => ({
				label: m.id,
				detail: m.detail,
				description: m.id === current ? localize('cloudeide.model.inUse', "in use") : undefined,
			})),
			{ placeHolder: localize('cloudeide.model.placeholder', "Which model should the agent run on?") });
		if (!picked || picked.label === current) {
			return;
		}
		await this.configurationService.updateValue(CLOUDEIDE_MODEL_SETTING, picked.label);
	}

	/**
	 * The project's own note about how work here should be done.
	 *
	 * `AGENTS.md` first, because it is the name other tools settled on and a
	 * project should not need one file per editor. `.cloudeiderules` after it
	 * for anyone who wants to say something only to this one.
	 *
	 * Read fresh each run rather than cached: somebody who edits the file to
	 * correct the agent expects the correction to take effect on the next
	 * question, not on the next window.
	 */
	private async readProjectRules(root: URI): Promise<{ path: string; text: string } | undefined> {
		const base = root.path.replace(/\/+$/, '');
		for (const name of ['AGENTS.md', '.cloudeiderules']) {
			try {
				const content = await this.fileService.readFile(root.with({ path: `${base}/${name}` }));
				// Capped. A project that puts its whole handbook here would
				// otherwise spend the run's context on it and leave none for
				// the code, and the first part is the part that says the rules.
				const text = content.value.toString().slice(0, MAX_PROJECT_RULES_CHARS);
				if (text.trim()) {
					return { path: name, text };
				}
			} catch {
				// Not there, or not readable. Most projects have neither file,
				// and that is not worth a word to anybody.
			}
		}
		return undefined;
	}

	/** The model this account should use, from settings, with a sensible default. */
	private configuredModel(): string {
		const configured = this.configurationService.getValue<string>(CLOUDEIDE_MODEL_SETTING);
		return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_AGENT_MODEL;
	}

	/**
	 * Uploads the open folder, unless it is the same one already up there.
	 *
	 * The hash is over paths and contents, so an answer that changes nothing
	 * costs one walk of the folder and no request — and a question asked
	 * three times in a row does not upload a project three times. It is kept
	 * in memory on purpose: a stale hash surviving a restart would skip the
	 * one upload that a fresh session definitely needs.
	 */
	private async syncWorkspace(): Promise<void> {
		if (this.contextService.getWorkspace().folders.length === 0) {
			return;
		}

		try {
			const files = await collectWorkspaceFiles(this.fileService, this.contextService);
			if (files.length === 0) {
				return;
			}

			const state = toWorkspaceState(files);
			const serialized = JSON.stringify(state);
			if (serialized === this.syncedState) {
				return;
			}

			this.appendStep(localize('cloudeide.syncing', "Reading the project"),
				localize('cloudeide.syncingFiles', "{0} files", files.length));
			await this.client.saveWorkspace(state);
			this.syncedState = serialized;
		} catch (err) {
			this.appendStep(localize('cloudeide.syncFailed',
				"Could not send the project — answering from the open files only"),
				err instanceof Error ? err.message : String(err));
		}
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
	/**
	 * A set of changes, with the diff and the two buttons that decide them.
	 *
	 * `runId` is the server's, and is absent for the local agent — which has
	 * no run on the server to report a verdict to, because the model was the
	 * only thing that left this machine.
	 */
	/**
	 * The thing that runs commands, and the gate in front of it.
	 *
	 * Made once per window and kept, so the shell the agent works in is the
	 * same shell across a conversation: a `cd` in one command still holds in
	 * the next, which is how a person would expect it to behave.
	 *
	 * Everything the agent asks to run comes through `approveCommand` first.
	 * There is no setting to turn that off and no list of commands that skip
	 * it. A rule like "anything starting with npm is safe" is exactly the
	 * rule `npm run deploy` walks through.
	 */
	private commandRunner(): IAgentCommandRunner {
		if (!this.runner) {
			const execute = this._register(this.instantiationService.createInstance(CloudeideCommandRunner));
			this.runner = {
				run: async (command: string, token: CancellationToken): Promise<CommandRunResult> => {
					const allowed = await this.approveCommand(command, token);
					if (!allowed) {
						return { output: '', refused: true };
					}
					return execute.run(command, token);
				},
			};
		}
		return this.runner;
	}

	/**
	 * Ask, and wait for an answer.
	 *
	 * The agent's loop is paused here, inside the tool call, which is what
	 * makes this a gate rather than a notification: nothing has run when the
	 * card appears, and nothing runs unless Run is pressed.
	 *
	 * Cancelling the run answers it too. Otherwise a person who pressed Stop
	 * would be left with a card still waiting for them, for a run that is
	 * already over.
	 */
	private approveCommand(command: string, token: CancellationToken): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const card = DOM.append(this.transcript, $('.cloudeide-permission'));

			const head = DOM.append(card, $('.cloudeide-permission-head'));
			head.textContent = localize('cloudeide.permission.head', "Run this command?");

			const line = DOM.append(card, $('code.cloudeide-permission-command'));
			line.textContent = command;

			const actions = DOM.append(card, $('.cloudeide-permission-actions'));
			const run = DOM.append(actions, $('button.cloudeide-button-primary')) as HTMLButtonElement;
			run.textContent = localize('cloudeide.permission.run', "Run");
			const skip = DOM.append(actions, $('button.cloudeide-button-quiet')) as HTMLButtonElement;
			skip.textContent = localize('cloudeide.permission.skip', "Don't run");

			this.transcript.scrollTop = this.transcript.scrollHeight;

			const listeners = new DisposableStore();
			let settled = false;
			const answer = (allowed: boolean, verdict: string) => {
				if (settled) {
					return;
				}
				settled = true;
				listeners.dispose();
				run.remove();
				skip.remove();
				DOM.append(actions, $('span.cloudeide-permission-settled')).textContent = verdict;
				resolve(allowed);
			};

			listeners.add(DOM.addDisposableListener(run, 'click',
				() => answer(true, localize('cloudeide.permission.running', "Running"))));
			listeners.add(DOM.addDisposableListener(skip, 'click',
				() => answer(false, localize('cloudeide.permission.skipped', "Not run"))));
			listeners.add(token.onCancellationRequested(
				() => answer(false, localize('cloudeide.permission.stopped', "Stopped"))));
			this._register(listeners);
		});
	}

	/**
	 * What the run changed, and the two decisions about it.
	 *
	 * Small on purpose. The change itself is already in the files, marked
	 * green and red, which is the place to read it — with the surrounding
	 * code, the syntax colouring and the width of a real editor. What is left
	 * for a three-hundred-pixel column is the list: which files, how much,
	 * and whether to keep it.
	 *
	 * Clicking a row opens that file. Keep saves; Undo puts everything back.
	 */
	/**
	 * A question from the agent, and the wait for an answer.
	 *
	 * The same shape as the command card — the run is paused inside the tool
	 * call, the card appears, and nothing continues until somebody presses
	 * something — but without its coloured edge. That edge means "this cannot
	 * be undone by pressing Discard afterwards", and a question cannot do any
	 * harm. Giving it the same warning stripe would make the warning mean
	 * nothing.
	 *
	 * Skip is a real answer, and cancelling the run answers it too. Otherwise
	 * a person who pressed Stop is left with a question about a run that is
	 * already over.
	 */
	private askQuestion(question: string, options: readonly string[], multiple: boolean, token: CancellationToken): Promise<string[] | undefined> {
		return new Promise<string[] | undefined>(resolve => {
			const card = DOM.append(this.transcript, $('.cloudeide-question'));

			const head = DOM.append(card, $('.cloudeide-question-head'));
			head.textContent = question;

			const list = DOM.append(card, $('.cloudeide-question-options'));
			const listeners = new DisposableStore();
			const picked = new Set<string>();
			let settled = false;

			const answer = (chosen: string[] | undefined, verdict: string) => {
				if (settled) {
					return;
				}
				settled = true;
				listeners.dispose();
				DOM.clearNode(list);
				const said = DOM.append(list, $('.cloudeide-question-answer'));
				said.textContent = verdict;
				resolve(chosen);
			};

			options.forEach((option, index) => {
				const button = DOM.append(list, $('button.cloudeide-question-option')) as HTMLButtonElement;
				button.setAttribute('role', multiple ? 'checkbox' : 'radio');
				button.setAttribute('aria-checked', 'false');

				/*
				 * A box when the answers combine, a number when they do not.
				 *
				 * The shape says how many you get to pick before you have
				 * pressed anything — a row of numbers that turns out to be
				 * multi-select, or a row of boxes where the first click ends
				 * the question, are both small betrayals.
				 */
				const mark = DOM.append(button, $(multiple
					? 'span.cloudeide-question-box'
					: 'span.cloudeide-question-ordinal'));
				if (!multiple) {
					mark.textContent = String(index + 1);
				}

				const label = DOM.append(button, $('span'));
				label.textContent = option;

				listeners.add(DOM.addDisposableListener(button, 'click', () => {
					if (!multiple) {
						answer([option], option);
						return;
					}
					const on = !picked.has(option);
					if (on) {
						picked.add(option);
					} else {
						picked.delete(option);
					}
					button.classList.toggle('cloudeide-question-picked', on);
					button.setAttribute('aria-checked', String(on));
					mark.textContent = on ? '\u2713' : '';
				}));
			});

			const actions = DOM.append(list, $('.cloudeide-question-actions'));

			if (multiple) {
				const go = DOM.append(actions, $('button.cloudeide-button-primary')) as HTMLButtonElement;
				go.textContent = localize('cloudeide.question.continue', "Continue");
				listeners.add(DOM.addDisposableListener(go, 'click', () => {
					const chosen = options.filter(o => picked.has(o));
					answer(chosen, chosen.length > 0
						? chosen.join(', ')
						: localize('cloudeide.question.none', "None of these"));
				}));
			}

			const skip = DOM.append(actions, $('button.cloudeide-question-skip')) as HTMLButtonElement;
			skip.textContent = localize('cloudeide.question.skip', "You decide");
			listeners.add(DOM.addDisposableListener(skip, 'click',
				() => answer(undefined, localize('cloudeide.question.skipped', "You decide"))));

			listeners.add(token.onCancellationRequested(
				() => answer(undefined, localize('cloudeide.question.stopped', "Stopped"))));
			this._register(listeners);

			this.transcript.scrollTop = this.transcript.scrollHeight;
		});
	}

	private appendProposal(historyId: string, runId: string | undefined, files: readonly PreviewedFile[]): void {
		const card = DOM.append(this.transcript, $('.cloudeide-proposal'));

		const head = DOM.append(card, $('.cloudeide-proposal-head'));
		head.textContent = files.length === 1
			? localize('cloudeide.proposal.oneChanged', "1 file changed")
			: localize('cloudeide.proposal.manyChanged', "{0} files changed", files.length);

		const folder = this.contextService.getWorkspace().folders[0];

		for (const file of files) {
			const row = DOM.append(card, $('button.cloudeide-proposal-file')) as HTMLButtonElement;
			row.title = localize('cloudeide.proposal.openFile', "Open {0}", file.path);

			const kind = DOM.append(row, $(`span.cloudeide-proposal-kind.cloudeide-proposal-${file.kind}`));
			kind.textContent = file.kind;
			const name = DOM.append(row, $('span.cloudeide-proposal-path'));
			name.textContent = file.path;

			if (file.added > 0 || file.removed > 0) {
				const tally = DOM.append(row, $('span.cloudeide-proposal-tally'));
				if (file.added > 0) {
					DOM.append(tally, $('span.cloudeide-proposal-added')).textContent = `+${file.added}`;
				}
				if (file.removed > 0) {
					DOM.append(tally, $('span.cloudeide-proposal-removed')).textContent = `\u2212${file.removed}`;
				}
			}

			if (folder && file.kind !== 'delete') {
				const target = folder.uri.with({ path: `${folder.uri.path.replace(/\/+$/, '')}/${file.path}` });
				this._register(DOM.addDisposableListener(row, 'click',
					() => void this.editorService.openEditor({ resource: target })));
			}
		}

		const actions = DOM.append(card, $('.cloudeide-proposal-actions'));
		const accept = DOM.append(actions, $('button.cloudeide-button-primary')) as HTMLButtonElement;
		accept.textContent = localize('cloudeide.proposal.keep', "Keep");
		const discard = DOM.append(actions, $('button.cloudeide-button-quiet')) as HTMLButtonElement;
		discard.textContent = localize('cloudeide.proposal.undo', "Undo");

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
				const saved = await this.preview.keep();
				if (runId) {
					await this.client.decideProposal(runId, 'applied');
				}
				this.history.settle(historyId, 'kept');
				this.renderHistory();
				settle(saved === 1
					? localize('cloudeide.proposal.keptOne', "Saved 1 file")
					: localize('cloudeide.proposal.keptMany', "Saved {0} files", saved));
			} catch (err) {
				accept.disabled = false;
				discard.disabled = false;
				this.setStatus(err instanceof Error ? err.message : String(err), 'error');
			}
		}));

		this._register(DOM.addDisposableListener(discard, 'click', async () => {
			accept.disabled = true;
			discard.disabled = true;
			try {
				await this.preview.undo();
				// Reported even though nothing was written: the server holds
				// the proposal open until it hears, and a recap that still
				// lists an undone file as pending is a recap that lies.
				if (runId) {
					await this.client.decideProposal(runId, 'discarded').catch(() => { /* best effort */ });
				}
				this.history.settle(historyId, 'undone');
				this.renderHistory();
				settle(localize('cloudeide.proposal.undone', "Undone"));
			} catch (err) {
				accept.disabled = false;
				discard.disabled = false;
				this.setStatus(err instanceof Error ? err.message : String(err), 'error');
			}
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
	/**
	 * Puts a finished run's changes into the files, and draws the card.
	 *
	 * The order matters: the change is on screen, in the file, before the
	 * card that asks about it exists — so the first thing the person sees is
	 * what happened, not a question about something they have not seen.
	 */
	private async showChanges(runId: string | undefined, changes: readonly FileChange[]): Promise<void> {
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.setStatus(localize('cloudeide.proposal.noFolder',
				"Open a folder before changing files."), 'error');
			return;
		}
		try {
			const files = await this.preview.show(folders[0].uri, changes);
			if (files.length > 0) {
				// Written down before anybody has decided, with the decision
				// filled in later. A run that changed files and was then
				// abandoned — window closed, question forgotten — is exactly
				// the one worth being able to find again.
				const id = runId ?? `local-${Date.now()}`;
				this.history.add({
					id,
					ask: this.lastAsk,
					at: new Date().toISOString(),
					files: files.map(f => ({ path: f.path, added: f.added, removed: f.removed })),
					outcome: 'pending',
				});
				this.appendProposal(id, runId, files);
				this.renderHistory();
				this.lastRun = { reply: this.lastReply, files: files.map(f => f.path) };
			}
		} catch (err) {
			this.setStatus(err instanceof Error ? err.message : String(err), 'error');
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}
}

/*
 * The diff renderer that used to live down here is gone, with its context
 * window, its line cap and its line counter — about a hundred and twenty
 * lines of it. The change is shown in the file now, so nothing in this panel
 * has to draw one, and the counts on each row come back from the marks that
 * were actually placed rather than from a second diff computed for the label.
 */

/** "4 minutes ago", because nobody subtracts a timestamp from now in their head. */
function when(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return iso;
	}
	const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
	if (minutes < 1) {
		return localize('cloudeide.history.justNow', "just now");
	}
	if (minutes < 60) {
		return localize('cloudeide.history.minutes', "{0}m ago", minutes);
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return localize('cloudeide.history.hours', "{0}h ago", hours);
	}
	return localize('cloudeide.history.days', "{0}d ago", Math.round(hours / 24));
}

/**
 * What became of a run's change.
 *
 * "Pending" is the one worth naming. A run whose change was never kept or
 * undone left files sitting unsaved in a window that has since closed, and
 * that is a thing somebody wants to know about rather than a blank.
 */
function outcomeLabel(outcome: HistoryRun['outcome']): string {
	switch (outcome) {
		case 'kept': return localize('cloudeide.history.kept', "kept");
		case 'undone': return localize('cloudeide.history.undone', "undone");
		default: return localize('cloudeide.history.pending', "never decided");
	}
}

/** "1m 22s", the way a person would say how long something took. */
function elapsed(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) {
		return localize('cloudeide.elapsed.seconds', "{0}s", seconds);
	}
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0
		? localize('cloudeide.elapsed.minutes', "{0}m", minutes)
		: localize('cloudeide.elapsed.minutesSeconds', "{0}m {1}s", minutes, rest);
}
