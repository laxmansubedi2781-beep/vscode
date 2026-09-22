/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CloudeideClient, type DeployDomain, type DeployEnvironment, type DeploymentSummary, type DeployStatus } from './cloudeideClient.js';
import { collectWorkspaceFiles } from './cloudeideWorkspace.js';

const $ = DOM.$;

/** The environments the server accepts, with what each one is for. */
const ENVIRONMENTS: readonly { id: DeployEnvironment; label: string; detail: string }[] = [
	{ id: 'development', label: localize('cloudeide.env.development', "Development"), detail: localize('cloudeide.env.developmentDetail', "A throwaway URL for checking a change.") },
	{ id: 'preview', label: localize('cloudeide.env.preview', "Preview"), detail: localize('cloudeide.env.previewDetail', "A shareable URL for review.") },
	{ id: 'production', label: localize('cloudeide.env.production', "Production"), detail: localize('cloudeide.env.productionDetail', "The real one, on your domain.") },
];

/**
 * Everything the account has on the internet, in the window that put it there.
 *
 * This used to be a dashboard on the web and a single Deploy button in the
 * chat panel beside this one. The button could start a deploy and could not
 * answer any question that follows one — what is live, what broke, what
 * address it is on, how to put a domain in front of it — so the answer was
 * always "open the browser", and the product was two products.
 *
 * It is a second view in the same container rather than a tab inside the
 * first, which is how this workbench has always stacked related surfaces:
 * Explorer does it with Folders, Outline and Timeline. The panes collapse
 * independently, remember their height, and can be dragged apart by anyone
 * who wants the chat full-height — none of which a hand-built tab strip
 * would have given.
 */
export class CloudeideCloudPanel extends ViewPane {

	static readonly ID = 'workbench.view.cloudeideCloud';

	private readonly client: CloudeideClient;

	private root!: HTMLElement;
	private deploymentsList!: HTMLElement;
	private domainsList!: HTMLElement;
	private environmentButton!: Button;
	private deployButton!: Button;
	private deployStatus!: HTMLElement;

	private deploying = false;

	/** Set once a refresh has run, so a collapsed pane costs nothing until opened. */
	private loaded = false;

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
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
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

		this.root = DOM.append(container, $('.cloudeide-cloud'));

		// ── where it goes ───────────────────────────────────────────────
		const envRow = DOM.append(this.root, $('.cloudeide-cloud-row'));
		DOM.append(envRow, $('span.cloudeide-cloud-label')).textContent =
			localize('cloudeide.cloud.environment', "Environment");
		this.environmentButton = this._register(new Button(envRow, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.environmentButton.label = this.environmentLabel();
		this._register(this.environmentButton.onDidClick(() => void this.pickEnvironment()));

		/*
		 * The one action on this pane, and it sits at the top.
		 *
		 * It was a quiet button in the chat composer beside Send, where it
		 * could start a deploy and then had nowhere to say what happened. Here
		 * it is the primary button and the list below it is the answer.
		 */
		this.deployButton = this._register(new Button(this.root, { ...defaultButtonStyles, supportIcons: true }));
		this.deployButton.element.classList.add('cloudeide-cloud-deploy');
		this.deployButton.label = localize('cloudeide.cloud.deploy', "Deploy");
		this.deployButton.element.title = localize('cloudeide.cloud.deployTitle', "Build the open folder and put it on a live URL");
		this._register(this.deployButton.onDidClick(() => void this.deploy()));

		this.deployStatus = DOM.append(this.root, $('p.cloudeide-cloud-deploy-status'));
		this.deployStatus.style.display = 'none';

		// ── what is live ────────────────────────────────────────────────
		this.section(localize('cloudeide.cloud.deployments', "Deployments"), () => void this.refreshDeployments());
		this.deploymentsList = DOM.append(this.root, $('.cloudeide-cloud-list'));

		// ── where it answers from ───────────────────────────────────────
		const domainsHead = this.section(localize('cloudeide.cloud.domains', "Domains"), () => void this.refreshDomains());
		const addDomain = this._register(new Button(domainsHead, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		addDomain.element.classList.add('cloudeide-cloud-head-button');
		addDomain.label = localize('cloudeide.cloud.addDomain', "Add");
		addDomain.element.title = localize('cloudeide.cloud.addDomainTitle', "Put a domain you own in front of this project");
		this._register(addDomain.onDidClick(() => void this.promptForDomain()));
		this.domainsList = DOM.append(this.root, $('.cloudeide-cloud-list'));

		// Loaded when the pane is first opened rather than on a timer: a
		// collapsed pane should cost nothing, and these are network calls.
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible && !this.loaded) {
				void this.refresh();
			}
		}));

		if (this.isBodyVisible()) {
			void this.refresh();
		}
	}

	/** A heading with a refresh button, which every list here wants. */
	private section(title: string, refresh: () => void): HTMLElement {
		const head = DOM.append(this.root, $('.cloudeide-cloud-head'));
		DOM.append(head, $('h3.cloudeide-cloud-title')).textContent = title;
		const spacer = DOM.append(head, $('span.cloudeide-cloud-spacer'));
		spacer.textContent = '';
		const button = this._register(new Button(head, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		button.element.classList.add('cloudeide-cloud-head-button');
		button.label = `$(${Codicon.refresh.id})`;
		button.element.title = localize('cloudeide.cloud.refresh', "Refresh");
		this._register(button.onDidClick(refresh));
		return head;
	}

	private environmentLabel(): string {
		const current = this.client.environment;
		const known = ENVIRONMENTS.find(e => e.id === current);
		return `$(${Codicon.server.id}) ${known?.label ?? current}`;
	}

	/**
	 * The environment is a setting, so this writes one rather than holding
	 * state of its own: the chat pane's Deploy reads the same value, and two
	 * copies of "where does this go live" is how a deploy lands somewhere
	 * nobody chose.
	 */
	private async pickEnvironment(): Promise<void> {
		const picked = await this.quickInputService.pick(
			ENVIRONMENTS.map(e => ({ label: e.label, detail: e.detail, id: e.id })),
			{ placeHolder: localize('cloudeide.cloud.pickEnvironment', "Where should Deploy publish?") },
		);
		if (!picked) {
			return;
		}
		await this.configurationService.updateValue('cloudeide.environment', picked.id);
		this.environmentButton.label = this.environmentLabel();
	}

	private async refresh(): Promise<void> {
		this.loaded = true;
		await Promise.all([this.refreshDeployments(), this.refreshDomains()]);
	}

	private async refreshDeployments(): Promise<void> {
		DOM.clearNode(this.deploymentsList);
		this.placeholder(this.deploymentsList, localize('cloudeide.cloud.loading', "Loading…"));
		try {
			const deployments = await this.client.listDeployments(5);
			DOM.clearNode(this.deploymentsList);
			if (deployments.length === 0) {
				this.placeholder(this.deploymentsList, localize('cloudeide.cloud.noDeployments', "Nothing deployed yet."));
				return;
			}
			for (const deployment of deployments) {
				this.renderDeployment(deployment);
			}
		} catch (err) {
			DOM.clearNode(this.deploymentsList);
			this.placeholder(this.deploymentsList, err instanceof Error ? err.message : String(err), true);
		}
	}

	private renderDeployment(deployment: DeploymentSummary): void {
		const row = DOM.append(this.deploymentsList, $('.cloudeide-cloud-item'));

		const icon = DOM.append(row, $('span.cloudeide-cloud-item-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(iconForStatus(deployment.status)));
		icon.classList.add(`cloudeide-cloud-status-${toneForStatus(deployment.status)}`);

		const text = DOM.append(row, $('.cloudeide-cloud-item-text'));
		DOM.append(text, $('span.cloudeide-cloud-item-name')).textContent = deployment.environment;
		DOM.append(text, $('span.cloudeide-cloud-item-note')).textContent =
			deployment.errorSummary ?? `${deployment.status} · ${relativeTime(deployment.createdAt)}`;

		if (deployment.liveUrl) {
			const open = this._register(new Button(row, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			open.element.classList.add('cloudeide-cloud-head-button');
			open.label = `$(${Codicon.linkExternal.id})`;
			open.element.title = deployment.liveUrl;
			this._register(open.onDidClick(() => this.openerService.open(URI.parse(deployment.liveUrl!), { openExternal: true })));
		}
	}

	private async refreshDomains(): Promise<void> {
		DOM.clearNode(this.domainsList);
		this.placeholder(this.domainsList, localize('cloudeide.cloud.loading', "Loading…"));
		try {
			const domains = await this.client.listDomains();
			DOM.clearNode(this.domainsList);
			if (domains.length === 0) {
				this.placeholder(this.domainsList, localize('cloudeide.cloud.noDomains', "No domains yet."));
				return;
			}
			for (const domain of domains) {
				this.renderDomain(domain);
			}
		} catch (err) {
			DOM.clearNode(this.domainsList);
			this.placeholder(this.domainsList, err instanceof Error ? err.message : String(err), true);
		}
	}

	private renderDomain(domain: DeployDomain): void {
		const row = DOM.append(this.domainsList, $('.cloudeide-cloud-item'));

		const icon = DOM.append(row, $('span.cloudeide-cloud-item-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(domain.status === 'verified' ? Codicon.globe : Codicon.clock));
		icon.classList.add(`cloudeide-cloud-status-${domain.status === 'verified' ? 'ok' : domain.status === 'error' ? 'error' : 'muted'}`);

		const text = DOM.append(row, $('.cloudeide-cloud-item-text'));
		const name = DOM.append(text, $('span.cloudeide-cloud-item-name'));
		name.textContent = domain.hostname;
		const note = DOM.append(text, $('span.cloudeide-cloud-item-note'));
		note.textContent = domain.primary
			? localize('cloudeide.cloud.primary', "{0} · primary", domain.environment)
			: `${domain.environment} · ${domain.status}`;

		// The platform's own address is not an entry anybody can act on: it
		// cannot be removed, and it is already verified by construction.
		if (domain.isDefault) {
			return;
		}

		if (domain.status !== 'verified') {
			const check = this._register(new Button(row, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			check.element.classList.add('cloudeide-cloud-head-button');
			check.label = localize('cloudeide.cloud.check', "Check");
			check.element.title = localize('cloudeide.cloud.checkTitle', "Ask now whether the DNS record has taken effect");
			this._register(check.onDidClick(() => void this.checkDomain(domain, note)));
		}

		const remove = this._register(new Button(row, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		remove.element.classList.add('cloudeide-cloud-head-button');
		remove.label = `$(${Codicon.trash.id})`;
		remove.element.title = localize('cloudeide.cloud.removeDomain', "Remove {0}", domain.hostname);
		this._register(remove.onDidClick(() => void this.removeDomain(domain)));
	}

	private async checkDomain(domain: DeployDomain, note: HTMLElement): Promise<void> {
		note.textContent = localize('cloudeide.cloud.checking', "Checking…");
		try {
			const result = await this.client.verifyDomain(domain.id);
			if (result.status === 'verified') {
				await this.refreshDomains();
				return;
			}
			// Still pending is the common answer, and on its own it tells
			// nobody what to do. The record is what they need.
			if (result.validationRecord) {
				await this.showValidationRecord(domain.hostname, result.validationRecord);
			}
			note.textContent = `${domain.environment} · ${result.status}`;
		} catch (err) {
			note.textContent = err instanceof Error ? err.message : String(err);
		}
	}

	/**
	 * Shows the DNS record, in a dialog that can be copied out of.
	 *
	 * A domain sits pending until somebody creates this record at their
	 * registrar, and nothing else in this panel can do it for them.
	 */
	private async showValidationRecord(hostname: string, record: { name: string; type: string; value: string }): Promise<void> {
		await this.dialogService.info(
			localize('cloudeide.cloud.dnsTitle', "Add this record at your DNS provider"),
			localize('cloudeide.cloud.dnsBody',
				"{0} is waiting on one record.\n\nType\n{1}\n\nName\n{2}\n\nValue\n{3}\n\nIt can take a few minutes to take effect. Press Check when it has.",
				hostname, record.type, record.name, record.value),
		);
	}

	private async promptForDomain(): Promise<void> {
		const hostname = await this.quickInputService.input({
			prompt: localize('cloudeide.cloud.domainPrompt', "A domain you own, pointed at this project"),
			placeHolder: 'app.example.com',
			validateInput: async value => {
				const trimmed = value.trim();
				if (!trimmed) {
					return localize('cloudeide.cloud.domainEmpty', "Enter a domain.");
				}
				return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/i.test(trimmed)
					? undefined
					: localize('cloudeide.cloud.domainInvalid', "That does not look like a domain.");
			},
		});
		if (!hostname) {
			return;
		}

		try {
			const domain = await this.client.addDomain(hostname.trim().toLowerCase(), this.client.environment);
			await this.refreshDomains();
			const check = await this.client.verifyDomain(domain.id);
			if (check.validationRecord) {
				await this.showValidationRecord(domain.hostname, check.validationRecord);
			}
		} catch (err) {
			await this.dialogService.error(
				localize('cloudeide.cloud.domainFailed', "Could not add that domain"),
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	private async removeDomain(domain: DeployDomain): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('cloudeide.cloud.removeConfirm', "Remove {0}?", domain.hostname),
			detail: localize('cloudeide.cloud.removeDetail', "The site stops answering on this name. The deployment itself is untouched."),
			primaryButton: localize('cloudeide.cloud.removeYes', "Remove"),
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.client.removeDomain(domain.id);
		} catch (err) {
			await this.dialogService.error(
				localize('cloudeide.cloud.removeFailed', "Could not remove that domain"),
				err instanceof Error ? err.message : String(err),
			);
		}
		await this.refreshDomains();
	}

	private async deploy(): Promise<void> {
		if (this.deploying) {
			return;
		}

		// Unsaved buffers first. Deploying the version on disk while the editor
		// shows a newer one is the single most confusing thing this button
		// could do.
		await this.textFileService.save.call(this.textFileService, undefined as never).catch(() => undefined);

		this.setDeploying(true);
		this.setDeployStatus(localize('cloudeide.collecting', "Reading the folder…"), 'muted');

		try {
			const files = await collectWorkspaceFiles(this.fileService, this.contextService);
			if (files.length === 0) {
				this.setDeployStatus(localize('cloudeide.nothingToDeploy',
					"Nothing to deploy — open a folder with files in it first."), 'error');
				return;
			}

			this.setDeployStatus(localize('cloudeide.deployingN',
				"Building {0} file{1}…", files.length, files.length === 1 ? '' : 's'), 'muted');
			const started = await this.client.deploy(files);
			const finished = await this.pollDeployment(started.deploymentId);

			if (finished.liveUrl) {
				this.setDeployStatus(finished.liveUrl.replace(/^https?:\/\//, ''), 'ok', finished.liveUrl);
			} else if (finished.errorSummary) {
				this.setDeployStatus(finished.errorSummary, 'error');
			} else {
				this.setDeployStatus(localize('cloudeide.deployFinished', "Deployment {0}.", finished.status), 'muted');
			}
		} catch (err) {
			this.setDeployStatus(err instanceof Error ? err.message : String(err), 'error');
		} finally {
			this.setDeploying(false);
			// The row for this run is what somebody looks at next, and it did
			// not exist when the pane last drew.
			await this.refreshDeployments();
		}
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
			if (!CloudeideCloudPanel.IN_PROGRESS.includes(last.status)) {
				return last;
			}
			this.setDeployStatus(localize('cloudeide.deployStatus', "Building… ({0})", last.status), 'muted');
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
	 * One line under the button, which is where a deploy reports.
	 *
	 * A live URL becomes a link rather than text: it is the thing the whole
	 * button exists to produce, and making somebody copy it out of a sentence
	 * would be a strange last step.
	 */
	private setDeployStatus(text: string, tone: 'muted' | 'error' | 'ok', href?: string): void {
		DOM.clearNode(this.deployStatus);
		this.deployStatus.style.display = '';
		this.deployStatus.className = `cloudeide-cloud-deploy-status cloudeide-cloud-status-${tone}`;

		if (href) {
			const link = DOM.append(this.deployStatus, $('a.cloudeide-cloud-link'));
			link.textContent = text;
			this._register(DOM.addDisposableListener(link, 'click', () => this.openerService.open(URI.parse(href), { openExternal: true })));
			return;
		}
		this.deployStatus.textContent = text;
	}

	private placeholder(target: HTMLElement, text: string, isError = false): void {
		const line = DOM.append(target, $('.cloudeide-cloud-placeholder'));
		line.textContent = text;
		if (isError) {
			line.classList.add('cloudeide-cloud-status-error');
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}
}

function iconForStatus(status: string): ThemeIcon {
	switch (status) {
		case 'ready':
		case 'succeeded':
		case 'success':
			return Codicon.check;
		case 'failed':
		case 'error':
		case 'cancelled':
			return Codicon.error;
		default:
			return Codicon.sync;
	}
}

function toneForStatus(status: string): 'ok' | 'error' | 'muted' {
	switch (status) {
		case 'ready':
		case 'succeeded':
		case 'success':
			return 'ok';
		case 'failed':
		case 'error':
		case 'cancelled':
			return 'error';
		default:
			return 'muted';
	}
}

/** "3 minutes ago", without pulling in a formatter for three cases. */
function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return iso;
	}
	const minutes = Math.round((Date.now() - then) / 60_000);
	if (minutes < 1) {
		return localize('cloudeide.cloud.justNow', "just now");
	}
	if (minutes < 60) {
		return localize('cloudeide.cloud.minutesAgo', "{0}m ago", minutes);
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return localize('cloudeide.cloud.hoursAgo', "{0}h ago", hours);
	}
	return localize('cloudeide.cloud.daysAgo', "{0}d ago", Math.round(hours / 24));
}
