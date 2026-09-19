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
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { URI } from '../../../../base/common/uri.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CloudeideClient, type ChatMessage, type DeployStatus } from './cloudeideClient.js';

const $ = DOM.$;

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
	private deployButton!: HTMLButtonElement;
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
		@ITextFileService private readonly textFileService: ITextFileService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
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

		const field = DOM.append(box, $('.cloudeide-field'));
		const token = DOM.append(field, $('input.cloudeide-input')) as HTMLInputElement;
		token.type = 'password';
		token.placeholder = 'cide_live_…';
		token.setAttribute('aria-label', localize('cloudeide.tokenLabel', "CloudeIDE API token"));

		const connect = DOM.append(field, $('button.cloudeide-button-primary')) as HTMLButtonElement;
		connect.textContent = localize('cloudeide.connect', "Connect");

		const error = DOM.append(box, $('p.cloudeide-error'));
		error.style.display = 'none';

		const hint = DOM.append(box, $('p.cloudeide-hint'));
		hint.textContent = localize('cloudeide.tokenHint', "Create a token under Settings → API tokens at ");
		const link = DOM.append(hint, $('a.cloudeide-link')) as HTMLAnchorElement;
		link.textContent = this.client.serverUrl.replace(/^https?:\/\//, '');
		this._register(DOM.addDisposableListener(link, 'click', () => {
			this.openerService.open(URI.parse(`${this.client.serverUrl}/app/settings`));
		}));

		const submit = async () => {
			const value = token.value.trim();
			if (!value) {
				return;
			}
			connect.disabled = true;
			connect.textContent = localize('cloudeide.connecting', "Connecting…");
			error.style.display = 'none';

			try {
				await this.client.setToken(value);
				// Verified before the panel switches. Storing a token that does
				// not work would leave the person in the chat view watching
				// every message fail with no way back to this field.
				const me = await this.client.whoami();
				token.value = '';
				this.showMain(me.email);
			} catch (err) {
				await this.client.clearToken();
				error.textContent = err instanceof Error ? err.message : String(err);
				error.style.display = '';
			} finally {
				connect.disabled = false;
				connect.textContent = localize('cloudeide.connect', "Connect");
			}
		};

		this._register(DOM.addDisposableListener(connect, 'click', () => void submit()));
		this._register(DOM.addDisposableListener(token, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				void submit();
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

		this.deployButton = DOM.append(row, $('button.cloudeide-button-quiet')) as HTMLButtonElement;
		this.deployButton.textContent = localize('cloudeide.deploy', "Deploy");
		this.deployButton.title = localize('cloudeide.deployTitle', "Build the open folder and put it on a live URL");

		// An arrow, not the word "Send". Deploy beside it is the button that
		// carries a consequence and deserves the words; sending a message is
		// the ordinary act, and every chat the person already uses marks it
		// with an upward arrow.
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
		this._register(DOM.addDisposableListener(this.deployButton, 'click', () => void this.deploy()));
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
		this.deployButton.disabled = busy;
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

		try {
			// The server streams, so the answer lands a fragment at a time. The
			// placeholder is cleared by the first one rather than up front, so
			// a turn that fails before any text still reads "Thinking…" and
			// then the error, never a blank bubble.
			let started = false;
			const reply = await this.client.chat(this.messages, chunk => {
				if (!started) {
					pending.textContent = '';
					started = true;
				}
				pending.textContent += chunk;
				this.transcript.scrollTop = this.transcript.scrollHeight;
			});
			pending.textContent = reply;
			this.messages.push({ role: 'assistant', content: reply });
			this.setStatus('', 'muted');
			this.statusLine.style.display = 'none';
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
	}

	private async deploy(): Promise<void> {
		if (this.busy) {
			return;
		}

		// Unsaved buffers first. Deploying the version on disk while the editor
		// shows a newer one is the single most confusing thing this button
		// could do.
		await this.textFileService.save.call(this.textFileService, undefined as never).catch(() => undefined);

		this.setBusy(true);
		this.setStatus(localize('cloudeide.collecting', "Reading the folder…"), 'muted');

		try {
			const files = await this.collectWorkspaceFiles();
			if (files.length === 0) {
				this.setStatus(localize('cloudeide.nothingToDeploy',
					"Nothing to deploy — open a folder with files in it first."), 'error');
				return;
			}

			this.setStatus(localize('cloudeide.deployingN',
				"Building {0} file{1}…", files.length, files.length === 1 ? '' : 's'), 'muted');
			const started = await this.client.deploy(files);
			const finished = await this.pollDeployment(started.deploymentId);

			if (finished.liveUrl) {
				this.setStatus(finished.liveUrl.replace(/^https?:\/\//, ''), 'ok', finished.liveUrl);
			} else if (finished.errorSummary) {
				this.setStatus(finished.errorSummary, 'error');
			} else {
				this.setStatus(localize('cloudeide.deployFinished', "Deployment {0}.", finished.status), 'muted');
			}
		} catch (err) {
			this.setStatus(err instanceof Error ? err.message : String(err), 'error');
		} finally {
			this.setBusy(false);
		}
	}

	/**
	 * Everything in the open folder that belongs in a deploy.
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
	private async collectWorkspaceFiles(): Promise<{ path: string; content: string }[]> {
		const folders = this.contextService.getWorkspace().folders;
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
				stat = await this.fileService.resolve(dir);
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
					const content = await this.fileService.readFile(child.resource);
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
	 * Waits for the build to settle.
	 *
	 * Polls rather than streams because the deploy endpoints are plain REST and
	 * a socket for one button is not worth the reconnection logic. Gives up
	 * after ten minutes with the last status it saw, instead of spinning
	 * forever on a build that will never report.
	 */
	/*
	 * The statuses the server actually writes. An earlier version waited for
	 * "ready" or "live", which it never writes, and spelled cancelled with two
	 * letters l — so a finished deployment kept being reported as building
	 * until the poll timed out.
	 */
	private static readonly IN_PROGRESS = ['queued', 'building', 'deploying'];

	private async pollDeployment(deploymentId: string): Promise<DeployStatus> {
		const deadline = Date.now() + 10 * 60 * 1000;
		let last: DeployStatus = { id: deploymentId, status: 'queued' };

		while (Date.now() < deadline) {
			last = await this.client.deploymentStatus(deploymentId);
			if (!CloudeidePanel.IN_PROGRESS.includes(last.status)) {
				return last;
			}
			this.setStatus(localize('cloudeide.deployStatus', "Building… ({0})", last.status), 'muted');
			await new Promise(resolve => setTimeout(resolve, 3000));
		}
		return last;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}
}
