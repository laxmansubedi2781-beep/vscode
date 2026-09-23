/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cloud: everything this account has on the internet, in the window that put
 * it there.
 *
 * Three questions, in the order somebody asks them. Where is my project? What
 * has gone out, and did it work? What address is it on, and how do I put my
 * own domain in front of it? Before this, the first was a Deploy button that
 * could start a deploy and answer nothing that follows one, and the other two
 * were a browser tab — which made one product into two.
 *
 * Nothing here is new capability. The server has had `/deploy/run`,
 * `/deploy/domains`, its verify and its primary since before the editor did;
 * this is the screen those were waiting for.
 */

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { CloudeideClient, type DeployDomain, type DeployEnvironment, type DeploymentSummary, type DeployStatus } from './cloudeideClient.js';
import { CloudeideCloudInput } from './cloudeideCloudInput.js';
import { collectWorkspaceFiles } from './cloudeideWorkspace.js';

const $ = DOM.$;

/** The environments `/deploy/run` accepts, with what each one is for. */
const ENVIRONMENTS: readonly { id: DeployEnvironment; label: string; detail: string }[] = [
	{ id: 'development', label: localize('cloudeide.cloud.env.development', "Development"), detail: localize('cloudeide.cloud.env.developmentDetail', "A throwaway URL for checking a change.") },
	{ id: 'preview', label: localize('cloudeide.cloud.env.preview', "Preview"), detail: localize('cloudeide.cloud.env.previewDetail', "A shareable URL for review.") },
	{ id: 'production', label: localize('cloudeide.cloud.env.production', "Production"), detail: localize('cloudeide.cloud.env.productionDetail', "The real one, on your domain.") },
];

/** The statuses the server writes while a build is still going. */
const IN_PROGRESS = ['queued', 'building', 'deploying'];

/** How many past deployments the list shows. */
const DEPLOYMENTS_SHOWN = 8;

export class CloudeideCloudEditor extends EditorPane {

	static readonly ID = 'workbench.editor.cloudeideCloud';

	private readonly client: CloudeideClient;
	private readonly rendered = this._register(new DisposableStore());

	private scroller!: HTMLElement;
	private liveLine!: HTMLElement;
	private deploymentsList!: HTMLElement;
	private domainsList!: HTMLElement;
	private deployStatus!: HTMLElement;
	private deployButton!: Button;
	private environmentButton!: Button;

	private deploying = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(CloudeideCloudEditor.ID, group, telemetryService, themeService, storageService);
		this.client = new CloudeideClient(secretStorageService, configurationService);
	}

	// ── the page ──────────────────────────────────────────────────────────────

	protected override createEditor(parent: HTMLElement): void {
		this.scroller = DOM.append(parent, $('.cloudeide-cloud-editor'));

		/*
		 * A column, not the full width of the editor.
		 *
		 * This pane can be two thousand pixels across on a wide screen, and a
		 * row whose left end is a domain and whose right end is its status
		 * becomes two things nobody reads together. Settings does the same for
		 * the same reason.
		 */
		const page = DOM.append(this.scroller, $('.cloudeide-cloud-page'));

		this.buildHeader(page);
		this.buildDeployments(page);
		this.buildDomains(page);
	}

	private buildHeader(page: HTMLElement): void {
		const header = DOM.append(page, $('.cloudeide-cloud-header'));

		const name = DOM.append(header, $('h1.cloudeide-cloud-project'));
		name.textContent = this.projectName();

		this.liveLine = DOM.append(header, $('.cloudeide-cloud-live'));

		const actions = DOM.append(header, $('.cloudeide-cloud-actions'));

		this.deployButton = this._register(new Button(actions, defaultButtonStyles));
		this.deployButton.label = localize('cloudeide.cloud.deploy', "Deploy");
		this.deployButton.element.title = localize('cloudeide.cloud.deployTitle',
			"Build the open folder and put it on a live URL");
		this._register(this.deployButton.onDidClick(() => void this.deploy()));

		this.environmentButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		this.environmentButton.element.classList.add('cloudeide-cloud-environment');
		this.setEnvironmentLabel();
		this.environmentButton.element.title = localize('cloudeide.cloud.environmentTitle',
			"Where Deploy publishes");
		this._register(this.environmentButton.onDidClick(() => void this.pickEnvironment()));

		this.deployStatus = DOM.append(header, $('.cloudeide-cloud-deploy-status'));
		this.deployStatus.style.display = 'none';
	}

	private buildDeployments(page: HTMLElement): void {
		const section = DOM.append(page, $('.cloudeide-cloud-section'));
		this.sectionHead(section, localize('cloudeide.cloud.deployments', "Deployments"),
			() => void this.refreshDeployments());
		this.deploymentsList = DOM.append(section, $('.cloudeide-cloud-list'));
	}

	private buildDomains(page: HTMLElement): void {
		const section = DOM.append(page, $('.cloudeide-cloud-section'));
		const head = this.sectionHead(section, localize('cloudeide.cloud.domains', "Domains"),
			() => void this.refreshDomains());

		const add = this._register(new Button(head, { ...defaultButtonStyles, secondary: true }));
		add.element.classList.add('cloudeide-cloud-quiet');
		add.label = localize('cloudeide.cloud.addDomain', "Add domain");
		add.element.title = localize('cloudeide.cloud.addDomainTitle',
			"Put a domain you own in front of this project");
		this._register(add.onDidClick(() => void this.addDomain()));

		this.domainsList = DOM.append(section, $('.cloudeide-cloud-list'));
	}

	/** A section's heading, with the refresh button every section wants. */
	private sectionHead(section: HTMLElement, title: string, refresh: () => void): HTMLElement {
		const head = DOM.append(section, $('.cloudeide-cloud-section-head'));
		const label = DOM.append(head, $('span.cloudeide-cloud-section-title'));
		label.textContent = title;

		const spacer = DOM.append(head, $('span.cloudeide-cloud-spacer'));
		spacer.textContent = '';

		const button = DOM.append(head, $('button.cloudeide-cloud-icon-button')) as HTMLButtonElement;
		button.title = localize('cloudeide.cloud.refresh', "Refresh");
		button.setAttribute('aria-label', button.title);
		DOM.append(button, $(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		this._register(DOM.addDisposableListener(button, 'click', () => refresh()));
		return head;
	}

	// ── the workbench's side of an editor ─────────────────────────────────────

	override async setInput(input: CloudeideCloudInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		// Both, and neither waits for the other: a slow domain list should not
		// hold up the deployment a person just started.
		void this.refreshDeployments();
		void this.refreshDomains();
	}

	override focus(): void {
		super.focus();
		this.scroller?.focus();
	}

	override layout(dimension: DOM.Dimension): void {
		if (this.scroller) {
			this.scroller.style.width = `${dimension.width}px`;
			this.scroller.style.height = `${dimension.height}px`;
		}
	}

	// ── deploying ─────────────────────────────────────────────────────────────

	private projectName(): string {
		const folders = this.contextService.getWorkspace().folders;
		return folders.length > 0
			? folders[0].name
			: localize('cloudeide.cloud.noFolder', "No folder open");
	}

	private setEnvironmentLabel(): void {
		const current = this.configurationService.getValue<string>('cloudeide.environment');
		const found = ENVIRONMENTS.find(e => e.id === current) ?? ENVIRONMENTS[2];
		this.environmentButton.label = found.label;
	}

	private async pickEnvironment(): Promise<void> {
		const picked = await this.quickInputService.pick(
			ENVIRONMENTS.map(e => ({ id: e.id, label: e.label, detail: e.detail })),
			{ placeHolder: localize('cloudeide.cloud.pickEnvironment', "Where should Deploy publish?") });
		if (!picked) {
			return;
		}
		await this.configurationService.updateValue('cloudeide.environment', picked.id);
		this.setEnvironmentLabel();
	}

	private async deploy(): Promise<void> {
		if (this.deploying) {
			return;
		}

		/*
		 * Unsaved buffers first.
		 *
		 * Deploying what is on disk while the editor shows something newer is
		 * the single most confusing thing this button could do: the person
		 * looks at their change, presses Deploy, and the live site does not
		 * have it.
		 */
		await this.textFileService.save.call(this.textFileService, undefined as never).catch(() => undefined);

		this.setDeploying(true);
		this.setDeployStatus(localize('cloudeide.cloud.collecting', "Reading the folder…"), 'muted');

		try {
			const files = await collectWorkspaceFiles(this.fileService, this.contextService);
			if (files.length === 0) {
				this.setDeployStatus(localize('cloudeide.cloud.nothingToDeploy',
					"Nothing to deploy — open a folder with files in it first."), 'error');
				return;
			}

			this.setDeployStatus(localize('cloudeide.cloud.deployingN',
				"Building {0} file{1}…", files.length, files.length === 1 ? '' : 's'), 'muted');

			const started = await this.client.deploy(files);
			const finished = await this.pollDeployment(started.deploymentId);

			if (finished.liveUrl) {
				this.setDeployStatus(finished.liveUrl.replace(/^https?:\/\//, ''), 'ok', finished.liveUrl);
			} else if (finished.errorSummary) {
				this.setDeployStatus(finished.errorSummary, 'error');
			} else {
				this.setDeployStatus(localize('cloudeide.cloud.deployFinished',
					"Deployment {0}.", finished.status), 'muted');
			}
		} catch (err) {
			this.setDeployStatus(err instanceof Error ? err.message : String(err), 'error');
		} finally {
			this.setDeploying(false);
			// The row for this run is what somebody looks at next, and it did
			// not exist when the list last drew.
			await this.refreshDeployments();
		}
	}

	/**
	 * Waits for the build to settle.
	 *
	 * Polls rather than streams: the deploy endpoints are plain REST, and a
	 * socket for one button is not worth its reconnection logic. Gives up
	 * after ten minutes with the last status it saw, rather than spinning on a
	 * build that will never report.
	 */
	private async pollDeployment(deploymentId: string): Promise<DeployStatus> {
		const deadline = Date.now() + 10 * 60 * 1000;
		let last: DeployStatus = { id: deploymentId, status: 'queued' };

		while (Date.now() < deadline) {
			last = await this.client.deploymentStatus(deploymentId);
			if (!IN_PROGRESS.includes(last.status)) {
				return last;
			}
			this.setDeployStatus(localize('cloudeide.cloud.deployStatus',
				"Building… ({0})", last.status), 'muted');
			await new Promise(resolve => setTimeout(resolve, 3000));
		}
		return last;
	}

	private setDeploying(deploying: boolean): void {
		this.deploying = deploying;
		this.deployButton.enabled = !deploying;
		this.environmentButton.enabled = !deploying;
	}

	/**
	 * One line under the buttons, which is where a deploy reports.
	 *
	 * A live URL becomes a link rather than text: it is the thing the button
	 * exists to produce, and making somebody select it out of a sentence would
	 * be a strange last step.
	 */
	private setDeployStatus(text: string, tone: 'muted' | 'error' | 'ok', href?: string): void {
		DOM.clearNode(this.deployStatus);
		this.deployStatus.style.display = '';
		this.deployStatus.className = `cloudeide-cloud-deploy-status cloudeide-cloud-${tone}`;

		if (href) {
			const link = DOM.append(this.deployStatus, $('a.cloudeide-cloud-link')) as HTMLAnchorElement;
			link.textContent = text;
			link.href = href;
			this.rendered.add(DOM.addDisposableListener(link, 'click', event => {
				DOM.EventHelper.stop(event, true);
				void this.openerService.open(URI.parse(href));
			}));
		} else {
			this.deployStatus.textContent = text;
		}
	}

	// ── deployments ───────────────────────────────────────────────────────────

	private async refreshDeployments(): Promise<void> {
		this.placeholder(this.deploymentsList, localize('cloudeide.cloud.loading', "Loading…"));
		try {
			const deployments = await this.client.listDeployments(DEPLOYMENTS_SHOWN);
			DOM.clearNode(this.deploymentsList);

			if (deployments.length === 0) {
				this.placeholder(this.deploymentsList, localize('cloudeide.cloud.noDeployments',
					"Nothing deployed yet. Press Deploy and this fills in."));
				this.setLiveLine(undefined);
				return;
			}

			for (const deployment of deployments) {
				this.deploymentRow(deployment);
			}

			// The newest one that actually went live is what the header's
			// address should be, which is not always the newest row: a build
			// that failed is still the most recent deployment.
			this.setLiveLine(deployments.find(d => d.liveUrl));
		} catch (err) {
			this.placeholder(this.deploymentsList, err instanceof Error ? err.message : String(err), true);
		}
	}

	/** The project's address and when it last changed, under its name. */
	private setLiveLine(live: DeploymentSummary | undefined): void {
		DOM.clearNode(this.liveLine);
		if (!live?.liveUrl) {
			this.liveLine.textContent = localize('cloudeide.cloud.notLive', "Not on the internet yet.");
			return;
		}

		const link = DOM.append(this.liveLine, $('a.cloudeide-cloud-address')) as HTMLAnchorElement;
		link.textContent = live.liveUrl.replace(/^https?:\/\//, '');
		link.href = live.liveUrl;
		this.rendered.add(DOM.addDisposableListener(link, 'click', event => {
			DOM.EventHelper.stop(event, true);
			void this.openerService.open(URI.parse(live.liveUrl!));
		}));

		const note = DOM.append(this.liveLine, $('span.cloudeide-cloud-dim'));
		note.textContent = localize('cloudeide.cloud.liveSince', "{0} · deployed {1}",
			live.environment, ago(live.createdAt));
	}

	private deploymentRow(deployment: DeploymentSummary): void {
		const row = DOM.append(this.deploymentsList, $('.cloudeide-cloud-row'));

		const dot = DOM.append(row, $('span.cloudeide-cloud-dot'));
		dot.classList.add(`cloudeide-cloud-dot-${tone(deployment.status)}`);
		dot.title = deployment.status;

		const env = DOM.append(row, $('span.cloudeide-cloud-env'));
		env.textContent = deployment.environment;

		const id = DOM.append(row, $('span.cloudeide-cloud-mono'));
		// The deployment id, shortened. The full one is in the title for
		// anybody who has to quote it in a support message.
		id.textContent = deployment.id.slice(0, 7);
		id.title = deployment.id;

		if (deployment.errorSummary) {
			const why = DOM.append(row, $('span.cloudeide-cloud-error'));
			why.textContent = deployment.errorSummary;
		} else if (deployment.liveUrl) {
			const link = DOM.append(row, $('a.cloudeide-cloud-link')) as HTMLAnchorElement;
			link.textContent = deployment.liveUrl.replace(/^https?:\/\//, '');
			link.href = deployment.liveUrl;
			this.rendered.add(DOM.addDisposableListener(link, 'click', event => {
				DOM.EventHelper.stop(event, true);
				void this.openerService.open(URI.parse(deployment.liveUrl!));
			}));
		}

		const when = DOM.append(row, $('span.cloudeide-cloud-when'));
		when.textContent = ago(deployment.createdAt);
		when.title = deployment.createdAt;
	}

	// ── domains ───────────────────────────────────────────────────────────────

	private async refreshDomains(): Promise<void> {
		this.placeholder(this.domainsList, localize('cloudeide.cloud.loading', "Loading…"));
		try {
			const domains = await this.client.listDomains();
			DOM.clearNode(this.domainsList);

			if (domains.length === 0) {
				this.placeholder(this.domainsList, localize('cloudeide.cloud.noDomains',
					"No domains yet. Add one you own and this will say what DNS record it needs."));
				return;
			}
			for (const domain of domains) {
				this.domainRow(domain);
			}
		} catch (err) {
			this.placeholder(this.domainsList, err instanceof Error ? err.message : String(err), true);
		}
	}

	private domainRow(domain: DeployDomain): void {
		const block = DOM.append(this.domainsList, $('.cloudeide-cloud-domain'));
		const row = DOM.append(block, $('.cloudeide-cloud-row'));

		// The two slots under the row are made now and filled later, so
		// nothing has to go looking for them by selector afterwards.
		const note = DOM.append(block, $('.cloudeide-cloud-note'));
		note.style.display = 'none';
		const record = DOM.append(block, $('.cloudeide-cloud-record'));
		record.style.display = 'none';

		const host = DOM.append(row, $('span.cloudeide-cloud-host'));
		host.textContent = domain.hostname;

		const where = DOM.append(row, $('span.cloudeide-cloud-dim'));
		where.textContent = domain.primary
			? localize('cloudeide.cloud.primary', "{0} · primary", domain.environment)
			: domain.environment;

		const state = DOM.append(row, $('span.cloudeide-cloud-state'));
		state.classList.add(`cloudeide-cloud-${tone(domain.status)}`);
		state.textContent = domain.status;

		// The address the platform gives every project cannot be removed, made
		// primary, or verified — it already is. Showing those buttons anyway
		// would be three ways to get an error message.
		if (domain.isDefault) {
			return;
		}

		const actions = DOM.append(row, $('.cloudeide-cloud-row-actions'));

		if (domain.status !== 'verified') {
			this.rowButton(actions, localize('cloudeide.cloud.check', "Check"),
				localize('cloudeide.cloud.checkTitle', "Ask now whether the DNS record has taken effect"),
				() => void this.checkDomain(domain, note, record));
		} else if (!domain.primary) {
			this.rowButton(actions, localize('cloudeide.cloud.makePrimary', "Make primary"),
				localize('cloudeide.cloud.makePrimaryTitle', "Send visitors here by default"),
				() => void this.makePrimary(domain));
		}

		this.rowButton(actions, localize('cloudeide.cloud.remove', "Remove"),
			localize('cloudeide.cloud.removeTitle', "Take {0} off this project", domain.hostname),
			() => void this.removeDomain(domain));

		// A domain waiting on DNS is waiting on a person doing something at
		// their registrar, so the record it wants is shown without being asked
		// for. Hiding it behind Check would mean pressing a button to find out
		// what you were supposed to have done.
		if (domain.status !== 'verified') {
			void this.showRecord(domain, record);
		}
	}

	private rowButton(parent: HTMLElement, label: string, title: string, run: () => void): void {
		const button = DOM.append(parent, $('button.cloudeide-cloud-row-button')) as HTMLButtonElement;
		button.textContent = label;
		button.title = title;
		this.rendered.add(DOM.addDisposableListener(button, 'click', () => run()));
	}

	private async checkDomain(domain: DeployDomain, note: HTMLElement, record: HTMLElement): Promise<void> {
		this.say(note, localize('cloudeide.cloud.checking', "Checking…"));
		try {
			const result = await this.client.verifyDomain(domain.id);
			if (result.status === 'verified') {
				await this.refreshDomains();
				return;
			}
			this.say(note, localize('cloudeide.cloud.stillWaiting',
				"Not visible yet. DNS can take a few minutes, sometimes a few hours."));
			await this.showRecord(domain, record, result.validationRecord ?? undefined);
		} catch (err) {
			this.say(note, err instanceof Error ? err.message : String(err), true);
		}
	}

	/**
	 * The record somebody has to create where they bought the domain.
	 *
	 * Copy is a button rather than a hope that selecting a monospace span goes
	 * well: this value is going into a form on another site, and one wrong
	 * character means an hour wondering why the check keeps failing.
	 */
	private async showRecord(domain: DeployDomain, card: HTMLElement, known?: { name: string; type: string; value: string }): Promise<void> {
		let record = known;
		if (!record) {
			try {
				record = (await this.client.verifyDomain(domain.id)).validationRecord ?? undefined;
			} catch {
				return; // The row already says the domain is not verified.
			}
		}
		if (!record) {
			return;
		}

		DOM.clearNode(card);
		card.style.display = '';

		const lead = DOM.append(card, $('.cloudeide-cloud-record-lead'));
		lead.textContent = localize('cloudeide.cloud.dnsLead',
			"Add this record where you bought {0}, then press Check.", domain.hostname);

		const line = DOM.append(card, $('.cloudeide-cloud-record-line'));
		for (const part of [record.type, record.name, record.value]) {
			const cell = DOM.append(line, $('span.cloudeide-cloud-mono'));
			cell.textContent = part;
		}

		const copy = DOM.append(line, $('button.cloudeide-cloud-icon-button')) as HTMLButtonElement;
		copy.title = localize('cloudeide.cloud.copyRecord', "Copy the value");
		copy.setAttribute('aria-label', copy.title);
		DOM.append(copy, $(`span${ThemeIcon.asCSSSelector(Codicon.copy)}`));
		this.rendered.add(DOM.addDisposableListener(copy, 'click', async () => {
			await this.clipboardService.writeText(record.value);
			copy.title = localize('cloudeide.cloud.copied', "Copied");
		}));
	}

	private async addDomain(): Promise<void> {
		const hostname = await this.quickInputService.input({
			prompt: localize('cloudeide.cloud.domainPrompt', "A domain you own, pointed at this project"),
			placeHolder: 'shop.example.com',
			validateInput: async value => {
				const trimmed = value.trim();
				if (!trimmed) {
					return localize('cloudeide.cloud.domainEmpty', "Enter a domain.");
				}
				// Deliberately loose: the server is the authority on what it
				// will accept, and a regex strict enough to be correct here
				// would reject somebody's perfectly real domain.
				return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed)
					? undefined
					: localize('cloudeide.cloud.domainInvalid', "That does not look like a domain.");
			},
		});
		if (!hostname) {
			return;
		}

		const current = this.configurationService.getValue<string>('cloudeide.environment');
		const environment = (ENVIRONMENTS.find(e => e.id === current) ?? ENVIRONMENTS[2]).id;

		try {
			await this.client.addDomain(hostname.trim(), environment);
			await this.refreshDomains();
		} catch (err) {
			this.placeholder(this.domainsList, err instanceof Error ? err.message : String(err), true);
		}
	}

	private async makePrimary(domain: DeployDomain): Promise<void> {
		try {
			await this.client.setPrimaryDomain(domain.id);
			await this.refreshDomains();
		} catch (err) {
			this.placeholder(this.domainsList, err instanceof Error ? err.message : String(err), true);
		}
	}

	private async removeDomain(domain: DeployDomain): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('cloudeide.cloud.removeConfirm', "Remove {0}?", domain.hostname),
			detail: localize('cloudeide.cloud.removeDetail',
				"Visitors on that address stop reaching this project. The DNS record at your registrar stays where it is."),
			primaryButton: localize('cloudeide.cloud.removeYes', "Remove"),
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.client.removeDomain(domain.id);
			await this.refreshDomains();
		} catch (err) {
			this.placeholder(this.domainsList, err instanceof Error ? err.message : String(err), true);
		}
	}

	// ── small things ──────────────────────────────────────────────────────────

	private placeholder(list: HTMLElement, text: string, isError = false): void {
		DOM.clearNode(list);
		const line = DOM.append(list, $('.cloudeide-cloud-placeholder'));
		line.textContent = text;
		if (isError) {
			line.classList.add('cloudeide-cloud-error');
		}
	}

	/** Puts a line under a domain's row, in the slot made for it. */
	private say(note: HTMLElement, text: string, isError = false): void {
		note.textContent = text;
		note.style.display = '';
		note.classList.toggle('cloudeide-cloud-error', isError);
	}
}

/** verified/ready things read as ok, failures as error, the rest as waiting. */
function tone(status: string): 'ok' | 'error' | 'wait' {
	if (status === 'verified' || status === 'succeeded' || status === 'active' || status === 'live') {
		return 'ok';
	}
	if (status === 'failed' || status === 'error' || status === 'cancelled') {
		return 'error';
	}
	return 'wait';
}

/**
 * "4 minutes ago", not a timestamp.
 *
 * Every row here answers "how recent is this", and nobody subtracts a
 * timestamp from now in their head. The exact time stays in the title
 * attribute for the one case where it matters.
 */
function ago(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return iso;
	}
	const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (seconds < 60) {
		return localize('cloudeide.cloud.justNow', "just now");
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return localize('cloudeide.cloud.minutes', "{0} minute{1} ago", minutes, minutes === 1 ? '' : 's');
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return localize('cloudeide.cloud.hours', "{0} hour{1} ago", hours, hours === 1 ? '' : 's');
	}
	const days = Math.round(hours / 24);
	if (days < 30) {
		return localize('cloudeide.cloud.days', "{0} day{1} ago", days, days === 1 ? '' : 's');
	}
	return new Date(then).toISOString().slice(0, 10);
}
