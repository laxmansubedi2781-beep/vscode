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
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { CloudeideCommandRunner, type CommandRunResult, type IAgentCommandRunner } from './cloudeideAgentCommand.js';
import { CloudeideAppliedMarks } from './cloudeideAppliedMarks.js';
import { CloudeideEditPreview, type PreviewedFile } from './cloudeideEditPreview.js';
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
	/** The green and red marks left on whatever the last Apply wrote. */
	private readonly appliedMarks = this._register(new CloudeideAppliedMarks(this.textModelService));
	/** Where a run's change lands, and what Keep and Undo act on. */
	private readonly preview = this._register(this.instantiationService.createInstance(CloudeideEditPreview, this.appliedMarks));

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

		this.transcript = DOM.append(this.mainView, $('.cloudeide-transcript'));
		this.renderEmptyTranscript();

		const composer = DOM.append(this.mainView, $('.cloudeide-composer'));

		this.input = DOM.append(composer, $('textarea.cloudeide-textarea')) as HTMLTextAreaElement;
		this.input.rows = 2;
		this.input.placeholder = localize('cloudeide.ask', "Ask for a change…");
		this.input.setAttribute('aria-label', localize('cloudeide.askLabel', "Ask for a change"));

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

	/**
	 * An empty transcript is left empty.
	 *
	 * It held a tagline and a line of instructions. Neither was read twice:
	 * the box underneath already says what to type, and the second line told
	 * people to press a Deploy button that is no longer on this panel.
	 */
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
		this.input.value = '';
		this.setBusy(true);

		const pending = this.appendTurn('assistant', localize('cloudeide.thinking', "Thinking…"));

		// Gathered per turn rather than once: the person may have opened,
		// edited or switched files since the last question, and stale context
		// is worse than none.
		const context = await this.gatherContext();

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
				const local = await this.runLocalAgent(pending, context);
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
		});

		const source = new CancellationTokenSource();
		this.runCancellation = source;

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
				tools: tools.schemas(),
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
		return reply;
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
	private appendProposal(runId: string | undefined, files: readonly PreviewedFile[]): void {
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
				this.appendProposal(runId, files);
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
