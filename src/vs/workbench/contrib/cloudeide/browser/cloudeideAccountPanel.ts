/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { CloudeideClient, type ApiToken } from './cloudeideClient.js';

const $ = DOM.$;

/** The sign-in contribution's command, by id — see the chat panel for why. */
const CLOUDEIDE_SIGN_IN_COMMAND = 'cloudeide.signIn';

/**
 * Who the account is, what it is allowed, and what it has left.
 *
 * All of this lived on the web dashboard, which meant that the answer to "how
 * many credits do I have" was a different application. The numbers here come
 * from the same endpoints that page calls; nothing was invented for this pane
 * and nothing is computed twice.
 *
 * What stays in a browser is the part a browser is genuinely required for:
 * paying, which ends on PayPal's own page, and minting an API token, which the
 * server refuses to a caller already holding one. Both are one button away and
 * both say where they are going.
 */
export class CloudeideAccountPanel extends ViewPane {

	static readonly ID = 'workbench.view.cloudeideAccount';

	private readonly client: CloudeideClient;

	private root!: HTMLElement;
	private identity!: HTMLElement;
	private planBlock!: HTMLElement;
	private tokensList!: HTMLElement;

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
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.client = new CloudeideClient(secretStorageService, configurationService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.root = DOM.append(container, $('.cloudeide-cloud.cloudeide-account'));

		this.identity = DOM.append(this.root, $('.cloudeide-account-identity'));
		this.planBlock = DOM.append(this.root, $('.cloudeide-account-plan'));

		const tokensHead = this.section(localize('cloudeide.account.tokens', "API tokens"), () => void this.refreshTokens());
		const newToken = this._register(new Button(tokensHead, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		newToken.element.classList.add('cloudeide-cloud-head-button');
		newToken.label = localize('cloudeide.account.newToken', "New");
		newToken.element.title = localize('cloudeide.account.newTokenTitle',
			"Opens the dashboard. A token cannot mint another token, so this editor cannot create one.");
		this._register(newToken.onDidClick(() => this.openDashboard('?settings=tokens')));
		this.tokensList = DOM.append(this.root, $('.cloudeide-cloud-list'));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible && !this.loaded) {
				void this.refresh();
			}
		}));
		if (this.isBodyVisible()) {
			void this.refresh();
		}
	}

	private section(title: string, refresh: () => void): HTMLElement {
		const head = DOM.append(this.root, $('.cloudeide-cloud-head'));
		DOM.append(head, $('h3.cloudeide-cloud-title')).textContent = title;
		DOM.append(head, $('span.cloudeide-cloud-spacer'));
		const button = this._register(new Button(head, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		button.element.classList.add('cloudeide-cloud-head-button');
		button.label = `$(${Codicon.refresh.id})`;
		button.element.title = localize('cloudeide.account.refresh', "Refresh");
		this._register(button.onDidClick(refresh));
		return head;
	}

	private openDashboard(path: string): void {
		this.openerService.open(URI.parse(`${this.client.webUrl}/app/${path}`), { openExternal: true });
	}

	private async refresh(): Promise<void> {
		this.loaded = true;
		await Promise.all([this.refreshIdentity(), this.refreshPlan(), this.refreshTokens()]);
	}

	private async refreshIdentity(): Promise<void> {
		DOM.clearNode(this.identity);
		try {
			const me = await this.client.profile();

			const who = DOM.append(this.identity, $('.cloudeide-account-who'));
			DOM.append(who, $('span.cloudeide-cloud-item-name')).textContent = me.name || me.email;
			if (me.name && me.email) {
				DOM.append(who, $('span.cloudeide-cloud-item-note')).textContent = me.email;
			}

			const signOut = this._register(new Button(this.identity, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			signOut.element.classList.add('cloudeide-cloud-head-button');
			signOut.label = localize('cloudeide.account.signOut', "Sign out");
			this._register(signOut.onDidClick(() => void this.signOut()));
		} catch {
			// Not signed in is not an error worth a red line here: the button
			// that fixes it is the whole content of this state.
			DOM.clearNode(this.identity);
			const line = DOM.append(this.identity, $('.cloudeide-cloud-placeholder'));
			line.textContent = localize('cloudeide.account.signedOut', "Not signed in.");

			const signIn = this._register(new Button(this.identity, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			signIn.element.classList.add('cloudeide-cloud-head-button');
			signIn.label = localize('cloudeide.account.signIn', "Sign in");
			this._register(signIn.onDidClick(async () => {
				await this.commandService.executeCommand(CLOUDEIDE_SIGN_IN_COMMAND).catch(() => undefined);
				await this.refresh();
			}));
		}
	}

	private async refreshPlan(): Promise<void> {
		DOM.clearNode(this.planBlock);
		try {
			const plan = await this.client.billingPlan();

			const head = DOM.append(this.planBlock, $('.cloudeide-cloud-row'));
			const name = DOM.append(head, $('span.cloudeide-account-plan-name'));
			name.textContent = plan.planName;
			DOM.append(head, $('span.cloudeide-cloud-spacer'));
			const price = DOM.append(head, $('span.cloudeide-cloud-item-note'));
			price.textContent = plan.amount > 0
				? localize('cloudeide.account.perMonth', "${0}/month", plan.amount)
				: localize('cloudeide.account.free', "Free");

			// Two numbers, because they are two different things: what the
			// plan includes each month, and what has been bought on top. A
			// single "credits" figure hides which one is about to run out.
			this.meter(localize('cloudeide.account.included', "Included this month"),
				plan.includedCreditsRemaining, plan.includedCredits);

			const purchased = DOM.append(this.planBlock, $('.cloudeide-cloud-row'));
			DOM.append(purchased, $('span.cloudeide-cloud-label')).textContent =
				localize('cloudeide.account.purchased', "Purchased credits");
			DOM.append(purchased, $('span.cloudeide-cloud-item-name')).textContent = plan.creditsBalance.toFixed(2);

			const manage = this._register(new Button(this.planBlock, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			manage.element.classList.add('cloudeide-cloud-head-button', 'cloudeide-account-manage');
			manage.label = localize('cloudeide.account.manage', "Manage billing");
			manage.element.title = localize('cloudeide.account.manageTitle', "Opens the dashboard — payment happens on PayPal's own page");
			this._register(manage.onDidClick(() => this.openDashboard('?settings=billing')));
		} catch (err) {
			const line = DOM.append(this.planBlock, $('.cloudeide-cloud-placeholder'));
			line.textContent = err instanceof Error ? err.message : String(err);
		}
	}

	/** A label, a bar, and the two numbers the bar is made of. */
	private meter(label: string, remaining: number, total: number): void {
		const row = DOM.append(this.planBlock, $('.cloudeide-account-meter'));

		const head = DOM.append(row, $('.cloudeide-cloud-row'));
		DOM.append(head, $('span.cloudeide-cloud-label')).textContent = label;
		DOM.append(head, $('span.cloudeide-cloud-item-note')).textContent =
			localize('cloudeide.account.ofTotal', "{0} of {1}", remaining.toFixed(2), total.toFixed(2));

		const track = DOM.append(row, $('.cloudeide-account-track'));
		const fill = DOM.append(track, $('.cloudeide-account-fill'));
		const fraction = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
		fill.style.width = `${Math.round(fraction * 100)}%`;
		if (fraction < 0.15) {
			fill.classList.add('cloudeide-account-fill-low');
		}
	}

	private async refreshTokens(): Promise<void> {
		DOM.clearNode(this.tokensList);
		try {
			const tokens = (await this.client.listTokens()).filter(t => t.state === 'active');
			if (tokens.length === 0) {
				const line = DOM.append(this.tokensList, $('.cloudeide-cloud-placeholder'));
				line.textContent = localize('cloudeide.account.noTokens', "No active tokens.");
				return;
			}
			for (const token of tokens) {
				this.renderToken(token);
			}
		} catch (err) {
			const line = DOM.append(this.tokensList, $('.cloudeide-cloud-placeholder'));
			line.textContent = err instanceof Error ? err.message : String(err);
		}
	}

	private renderToken(token: ApiToken): void {
		const row = DOM.append(this.tokensList, $('.cloudeide-cloud-item'));

		const icon = DOM.append(row, $('span.cloudeide-cloud-item-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.key), 'cloudeide-cloud-status-muted');

		const text = DOM.append(row, $('.cloudeide-cloud-item-text'));
		DOM.append(text, $('span.cloudeide-cloud-item-name')).textContent = token.name;
		DOM.append(text, $('span.cloudeide-cloud-item-note')).textContent =
			token.lastUsedAt
				? localize('cloudeide.account.lastUsed', "{0}… · last used {1}", token.prefix, token.lastUsedAt.slice(0, 10))
				: localize('cloudeide.account.neverUsed', "{0}… · never used", token.prefix);

		const revoke = this._register(new Button(row, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		revoke.element.classList.add('cloudeide-cloud-head-button');
		revoke.label = `$(${Codicon.trash.id})`;
		revoke.element.title = localize('cloudeide.account.revoke', "Revoke {0}", token.name);
		this._register(revoke.onDidClick(() => void this.revokeToken(token)));
	}

	private async revokeToken(token: ApiToken): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('cloudeide.account.revokeConfirm', "Revoke {0}?", token.name),
			detail: localize('cloudeide.account.revokeDetail',
				"Anything still using it stops working immediately. This cannot be undone."),
			primaryButton: localize('cloudeide.account.revokeYes', "Revoke"),
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.client.revokeToken(token.id);
		} catch (err) {
			await this.dialogService.error(
				localize('cloudeide.account.revokeFailed', "Could not revoke that token"),
				err instanceof Error ? err.message : String(err),
			);
		}
		await this.refreshTokens();
	}

	private async signOut(): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('cloudeide.account.signOutConfirm', "Sign out of CloudeIDE?"),
			detail: localize('cloudeide.account.signOutDetail',
				"The agent and Deploy stop working until you sign in again. Your files are untouched."),
			primaryButton: localize('cloudeide.account.signOutYes', "Sign out"),
		});
		if (!confirmed) {
			return;
		}
		await this.client.clearToken();
		await this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.root.style.height = `${height}px`;
	}
}
