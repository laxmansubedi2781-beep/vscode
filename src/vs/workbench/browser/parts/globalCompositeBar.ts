/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/globalCompositeBar.css';
import { localize } from '../../../nls.js';
import { ActionBar, ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { ACCOUNTS_ACTIVITY_ID, GLOBAL_ACTIVITY_ID } from '../../common/activity.js';
import { IActivityService } from '../../services/activity/common/activity.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { DisposableStore, Disposable } from '../../../base/common/lifecycle.js';
import { IColorTheme, IThemeService } from '../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { CompositeBarActionViewItem, CompositeBarAction, IActivityHoverOptions, ICompositeBarActionViewItemOptions, ICompositeBarColors } from './compositeBarActions.js';
import { Codicon } from '../../../base/common/codicons.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { registerIcon } from '../../../platform/theme/common/iconRegistry.js';
import { Action, IAction, Separator, SubmenuAction, toAction } from '../../../base/common/actions.js';
import { IMenu, IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { addDisposableListener, EventType, append, clearNode, hide, show, EventHelper, $, runWhenWindowIdle, getWindow } from '../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { EventType as TouchEventType, GestureEvent } from '../../../base/browser/touch.js';
import { AnchorAlignment, AnchorAxisAlignment } from '../../../base/browser/ui/contextview/contextview.js';
import { Lazy } from '../../../base/common/lazy.js';
import { getActionBarActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { AuthenticationSessionInfo, getCurrentAuthenticationSessionInfo } from '../../services/authentication/browser/authenticationService.js';
import { ACCOUNTS_AVATAR_SETTING, AuthenticationSessionAccount, IAuthenticationService, INTERNAL_AUTH_PROVIDER_PREFIX } from '../../services/authentication/common/authentication.js';
import { IWorkbenchEnvironmentService } from '../../services/environment/common/environmentService.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { ILifecycleService, LifecyclePhase } from '../../services/lifecycle/common/lifecycle.js';
import { IUserDataProfileService } from '../../services/userDataProfile/common/userDataProfile.js';
import { DEFAULT_ICON } from '../../services/userDataProfile/common/userDataProfileIcons.js';
import { isString } from '../../../base/common/types.js';
import { FileAccess } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { KeyCode } from '../../../base/common/keyCodes.js';
import { ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND } from '../../common/theme.js';
import { IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IDefaultAccountService } from '../../../platform/defaultAccount/common/defaultAccount.js';
import { WORKBENCH_MENU_MOTION_CLASS, workbenchMenuCloseAnimation } from '../actions/menuMotion.js';
import { createCodexAccountMenuActions, ICodexAccountService, shouldShowCodexAccount } from '../../services/agentHost/browser/codexAccountService.js';

const CLOUD_ACTIVITY_ID = 'workbench.actions.cloudeideCloud';

/*
 * The command this icon runs, spelled out rather than imported.
 *
 * It is declared in `contrib/cloudeide`, and a part importing a contrib is
 * the wrong direction — parts are what contribs build on. A command id is the
 * supported way across that line, which is why every other part in here
 * reaches its feature the same way.
 */
const CLOUD_OPEN_COMMAND = 'cloudeide.openCloud';

/**
 * The rail's Cloud icon.
 *
 * All it does is run the command, so there is exactly one thing in the
 * product that decides what opening Cloud means, and the palette entry and
 * this icon cannot drift apart.
 */
class CloudActivityAction extends CompositeBarAction {

	constructor(private readonly commandService: ICommandService) {
		super({
			id: CLOUD_ACTIVITY_ID,
			name: localize('cloudeideCloud', "Cloud"),
			classNames: ThemeIcon.asClassNameArray(GlobalCompositeBar.CLOUD_ICON),
		});
	}

	override async run(): Promise<void> {
		await this.commandService.executeCommand(CLOUD_OPEN_COMMAND);
	}
}

export class GlobalCompositeBar extends Disposable {

	static readonly ACCOUNTS_ICON = registerIcon('accounts-view-bar-icon', Codicon.account, localize('accountsViewBarIcon', "Accounts icon in the view bar."));

	/*
	 * Cloud, at the top of this group.
	 *
	 * The rail's upper half is built from view containers, and a view
	 * container opens a pane in the sidebar — there is no way to say "this
	 * icon opens an editor" up there. This lower group is the part of the
	 * rail that holds plain icons which run something, which is exactly what
	 * Cloud is: press it, the Cloud tab opens beside the code.
	 *
	 * It is an addition. Accounts and the gear keep their behaviour, their
	 * order relative to each other and their hide-Accounts setting; the index
	 * arithmetic below is now computed rather than written down, because it
	 * was two hardcoded 2s that assumed this bar could only ever hold two
	 * things.
	 */
	static readonly CLOUD_ICON = registerIcon('cloudeide-view-bar-icon', Codicon.cloud, localize('cloudeideViewBarIcon', "CloudeIDE Cloud icon in the view bar."));

	readonly element: HTMLElement;

	private readonly globalActivityAction = this._register(new Action(GLOBAL_ACTIVITY_ID));
	private readonly accountAction = this._register(new Action(ACCOUNTS_ACTIVITY_ID));
	private readonly cloudAction: CompositeBarAction;
	private readonly globalActivityActionBar: ActionBar;

	/** Cloud sits first, so Accounts is second whenever it is shown. */
	private get accountsActionIndex(): number {
		return 1;
	}

	constructor(
		private readonly contextMenuActionsProvider: () => IAction[],
		private readonly colors: (theme: IColorTheme) => ICompositeBarColors,
		private readonly activityHoverOptions: IActivityHoverOptions,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@ICommandService commandService: ICommandService,
	) {
		super();

		this.element = $('div');
		const contextMenuAlignmentOptions = () => ({
			anchorAlignment: configurationService.getValue('workbench.sideBar.location') === 'left' ? AnchorAlignment.RIGHT : AnchorAlignment.LEFT,
			anchorAxisAlignment: AnchorAxisAlignment.HORIZONTAL
		});
		this.globalActivityActionBar = this._register(new ActionBar(this.element, {
			actionViewItemProvider: (action, options) => {
				if (action.id === GLOBAL_ACTIVITY_ID) {
					return this.instantiationService.createInstance(GlobalActivityActionViewItem, this.contextMenuActionsProvider, { ...options, colors: this.colors, hoverOptions: this.activityHoverOptions }, contextMenuAlignmentOptions);
				}

				if (action.id === ACCOUNTS_ACTIVITY_ID) {
					return this.instantiationService.createInstance(AccountsActivityActionViewItem,
						this.contextMenuActionsProvider,
						{
							...options,
							colors: this.colors,
							hoverOptions: this.activityHoverOptions
						},
						contextMenuAlignmentOptions,
						(actions: IAction[]) => {
							actions.unshift(...[
								toAction({ id: 'hideAccounts', label: localize('hideAccounts', "Hide Accounts"), run: () => setAccountsActionVisible(storageService, false) }),
								new Separator()
							]);
						});
				}

				if (action.id === CLOUD_ACTIVITY_ID) {
					return this.instantiationService.createInstance(CompositeBarActionViewItem,
						this.cloudAction,
						{
							...options,
							// Without this the item renders its *name* — a
							// 48px rail showing the clipped word "Cloud"
							// sideways, which is what the first build did.
							icon: true,
							colors: this.colors,
							hoverOptions: this.activityHoverOptions,
						},
						// No badge on this one: nothing counts up here.
						() => false);
				}

				throw new Error(`No view item for action '${action.id}'`);
			},
			orientation: ActionsOrientation.VERTICAL,
			ariaLabel: localize('manage', "Manage"),
			preventLoopNavigation: true
		}));

		this.cloudAction = this._register(new CloudActivityAction(commandService));
		this.globalActivityActionBar.push(this.cloudAction);

		if (this.accountsVisibilityPreference) {
			this.globalActivityActionBar.push(this.accountAction, { index: this.accountsActionIndex });
		}

		this.globalActivityActionBar.push(this.globalActivityAction);

		this.registerListeners();
	}

	private registerListeners(): void {
		this.extensionService.whenInstalledExtensionsRegistered().then(() => {
			if (!this._store.isDisposed) {
				this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY, this._store)(() => this.toggleAccountsActivity()));
			}
		});
	}

	create(parent: HTMLElement): void {
		parent.appendChild(this.element);
	}

	focus(): void {
		this.globalActivityActionBar.focus(true);
	}

	getContextMenuActions(): IAction[] {
		return [toAction({ id: 'toggleAccountsVisibility', label: localize('accounts', "Accounts"), checked: this.accountsVisibilityPreference, run: () => this.accountsVisibilityPreference = !this.accountsVisibilityPreference })];
	}

	private toggleAccountsActivity() {
		// Cloud and the gear are always here; Accounts is the only one that
		// comes and goes. Counting what is actually in the bar says whether
		// it is currently shown, without anybody having to keep a number in
		// two places in step.
		const shown = this.globalActivityActionBar.length() > this.alwaysShownCount;
		if (shown === this.accountsVisibilityPreference) {
			return;
		}
		if (shown) {
			this.globalActivityActionBar.pull(this.accountsActionIndex);
		} else {
			this.globalActivityActionBar.push(this.accountAction, { index: this.accountsActionIndex });
		}
	}

	/** Cloud and the gear. */
	private readonly alwaysShownCount = 2;

	private get accountsVisibilityPreference(): boolean {
		return isAccountsActionVisible(this.storageService);
	}

	private set accountsVisibilityPreference(value: boolean) {
		setAccountsActionVisible(this.storageService, value);
	}
}

abstract class AbstractGlobalActivityActionViewItem extends CompositeBarActionViewItem {

	constructor(
		private readonly menuId: MenuId,
		action: CompositeBarAction,
		options: ICompositeBarActionViewItemOptions,
		private readonly contextMenuActionsProvider: () => IAction[],
		private readonly contextMenuAlignmentOptions: () => Readonly<{ anchorAlignment: AnchorAlignment; anchorAxisAlignment: AnchorAxisAlignment }> | undefined,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService protected override readonly configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IActivityService private readonly activityService: IActivityService,
	) {
		super(action, { draggable: false, icon: true, hasPopup: true, ...options }, () => true, themeService, hoverService, configurationService, keybindingService);

		this.updateItemActivity();
		this._register(this.activityService.onDidChangeActivity(viewContainerOrAction => {
			if (isString(viewContainerOrAction) && viewContainerOrAction === this.compositeBarActionItem.id) {
				this.updateItemActivity();
			}
		}));
	}

	private updateItemActivity(): void {
		(this.action as CompositeBarAction).activities = this.activityService.getActivity(this.compositeBarActionItem.id);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this._register(addDisposableListener(this.container, EventType.MOUSE_DOWN, async (e: MouseEvent) => {
			EventHelper.stop(e, true);
			const isLeftClick = e?.button !== 2;
			// Left-click run
			if (isLeftClick) {
				this.run();
			}
		}));

		// The rest of the activity bar uses context menu event for the context menu, so we match this
		this._register(addDisposableListener(this.container, EventType.CONTEXT_MENU, async (e: MouseEvent) => {
			// Let the item decide on the context menu instead of the toolbar
			e.stopPropagation();

			const disposables = new DisposableStore();
			const actions = await this.resolveContextMenuActions(disposables);

			const event = new StandardMouseEvent(getWindow(this.container), e);

			this.contextMenuService.showContextMenu({
				getAnchor: () => event,
				getActions: () => actions,
				getMenuClassName: () => WORKBENCH_MENU_MOTION_CLASS,
				onHide: () => disposables.dispose(),
				closeAnimation: workbenchMenuCloseAnimation
			});
		}));

		this._register(addDisposableListener(this.container, EventType.KEY_UP, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				EventHelper.stop(e, true);
				this.run();
			}
		}));

		this._register(addDisposableListener(this.container, TouchEventType.Tap, (e: GestureEvent) => {
			EventHelper.stop(e, true);
			this.run();
		}));
	}

	protected async resolveContextMenuActions(disposables: DisposableStore): Promise<IAction[]> {
		return this.contextMenuActionsProvider();
	}

	private async run(): Promise<void> {
		const disposables = new DisposableStore();
		const menu = disposables.add(this.menuService.createMenu(this.menuId, this.contextKeyService));
		const actions = await this.resolveMainMenuActions(menu, disposables);
		const { anchorAlignment, anchorAxisAlignment } = this.contextMenuAlignmentOptions() ?? { anchorAlignment: undefined, anchorAxisAlignment: undefined };

		this.contextMenuService.showContextMenu({
			getAnchor: () => this.label,
			anchorAlignment,
			anchorAxisAlignment,
			getActions: () => actions,
			getMenuClassName: () => WORKBENCH_MENU_MOTION_CLASS,
			onHide: () => disposables.dispose(),
			menuActionOptions: { renderShortTitle: true },
			closeAnimation: workbenchMenuCloseAnimation
		});

	}

	protected async resolveMainMenuActions(menu: IMenu, _disposable: DisposableStore): Promise<IAction[]> {
		return getActionBarActions(menu.getActions({ renderShortTitle: true })).secondary;
	}
}

export class AccountsActivityActionViewItem extends AbstractGlobalActivityActionViewItem {

	static readonly ACCOUNTS_VISIBILITY_PREFERENCE_KEY = 'workbench.activity.showAccounts';

	private readonly groupedAccounts: Map<string, (AuthenticationSessionAccount & { canSignOut: boolean })[]> = new Map();
	private readonly problematicProviders: Set<string> = new Set();

	private initialized = false;
	private sessionFromEmbedder = new Lazy<Promise<AuthenticationSessionInfo | undefined>>(() => getCurrentAuthenticationSessionInfo(this.secretStorageService, this.productService));
	private avatarImg: HTMLImageElement | undefined;

	constructor(
		contextMenuActionsProvider: () => IAction[],
		options: ICompositeBarActionViewItemOptions,
		contextMenuAlignmentOptions: () => Readonly<{ anchorAlignment: AnchorAlignment; anchorAxisAlignment: AnchorAxisAlignment }> | undefined,
		private readonly fillContextMenuActions: (actions: IAction[]) => void,
		@IThemeService themeService: IThemeService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IHoverService hoverService: IHoverService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IProductService private readonly productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
		@IActivityService activityService: IActivityService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
		@ICodexAccountService private readonly codexAccountService: ICodexAccountService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
	) {
		const action = instantiationService.createInstance(CompositeBarAction, {
			id: ACCOUNTS_ACTIVITY_ID,
			name: localize('accounts', "Accounts"),
			classNames: ThemeIcon.asClassNameArray(GlobalCompositeBar.ACCOUNTS_ICON)
		});
		super(MenuId.AccountsContext, action, options, contextMenuActionsProvider, contextMenuAlignmentOptions, themeService, hoverService, menuService, contextMenuService, contextKeyService, configurationService, keybindingService, activityService);
		this._register(action);
		this.registerListeners();
		this.initialize();
	}

	private registerListeners(): void {
		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(async (e) => {
			await this.addAccountsFromProvider(e.id);
			this.updateAvatar();
		}));

		this._register(this.authenticationService.onDidUnregisterAuthenticationProvider((e) => {
			this.groupedAccounts.delete(e.id);
			this.problematicProviders.delete(e.id);
			this.updateAvatar();
		}));

		this._register(this.authenticationService.onDidChangeSessions(async e => {
			if (e.event.removed) {
				for (const removed of e.event.removed) {
					this.removeAccount(e.providerId, removed.account);
				}
			}
			for (const changed of [...(e.event.changed ?? []), ...(e.event.added ?? [])]) {
				try {
					await this.addOrUpdateAccount(e.providerId, changed.account);
				} catch (e) {
					this.logService.error(e);
				}
			}
			this.updateAvatar();
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ACCOUNTS_AVATAR_SETTING)) {
				this.updateAvatar();
			}
		}));

		this._register(this.defaultAccountService.onDidChangeDefaultAccount(() => {
			this.updateAvatar();
		}));
	}

	// This function exists to ensure that the accounts are added for auth providers that had already been registered
	// before the menu was created.
	private async initialize(): Promise<void> {
		// Resolving the menu doesn't need to happen immediately, so we can wait until after the workbench has been restored
		// and only run this when the system is idle.
		await this.lifecycleService.when(LifecyclePhase.Restored);
		if (this._store.isDisposed) {
			return;
		}
		const disposable = this._register(runWhenWindowIdle(getWindow(this.element), async () => {
			await this.doInitialize();
			disposable.dispose();
		}));
	}

	private async doInitialize(): Promise<void> {
		const providerIds = this.authenticationService.getProviderIds();
		const results = await Promise.allSettled(providerIds.map(providerId => this.addAccountsFromProvider(providerId)));

		// Log any errors that occurred while initializing. We try to be best effort here to show the most amount of accounts
		for (const result of results) {
			if (result.status === 'rejected') {
				this.logService.error(result.reason);
			}
		}

		this.initialized = true;
		this.updateAvatar();
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this.avatarImg = $('img.accounts-avatar') as HTMLImageElement;
		this.avatarImg.alt = '';
		this.avatarImg.setAttribute('aria-hidden', 'true');
		this.avatarImg.draggable = false;
		this.avatarImg.referrerPolicy = 'no-referrer';
		this.avatarImg.style.display = 'none';
		this.avatarImg.onerror = () => {
			this.avatarImg!.style.display = 'none';
			this.label.classList.remove('has-avatar');
		};
		append(this.label, this.avatarImg);

		this.updateAvatar();
	}

	private updateAvatar(): void {
		if (!this.avatarImg) {
			return;
		}

		let avatarIcon: URI | undefined;
		if (this.configurationService.getValue<boolean>(ACCOUNTS_AVATAR_SETTING)) {
			avatarIcon = this.getDefaultAccountAvatarIcon();
			if (!avatarIcon) {
				for (const accounts of this.groupedAccounts.values()) {
					for (const account of accounts) {
						if (account.icon) {
							avatarIcon = account.icon;
							break;
						}
					}
					if (avatarIcon) {
						break;
					}
				}
			}
		}

		if (avatarIcon) {
			this.avatarImg.src = FileAccess.uriToBrowserUri(avatarIcon).toString(true);
			this.avatarImg.style.display = '';
			this.label.classList.add('has-avatar');
		} else {
			this.avatarImg.removeAttribute('src');
			this.avatarImg.style.display = 'none';
			this.label.classList.remove('has-avatar');
		}
	}

	private getDefaultAccountAvatarIcon(): URI | undefined {
		const currentDefaultAccount = this.defaultAccountService.currentDefaultAccount;
		if (!currentDefaultAccount) {
			return undefined;
		}

		const accounts = this.groupedAccounts.get(currentDefaultAccount.authenticationProvider.id);
		return accounts?.find(account => account.label === currentDefaultAccount.accountName)?.icon;
	}

	//#region overrides

	protected override async resolveMainMenuActions(accountsMenu: IMenu, disposables: DisposableStore): Promise<IAction[]> {
		await super.resolveMainMenuActions(accountsMenu, disposables);

		const providers = this.authenticationService.getProviderIds().filter(p => !p.startsWith(INTERNAL_AUTH_PROVIDER_PREFIX));
		const otherCommands = accountsMenu.getActions();
		let menus: IAction[] = [];

		const registeredProviders = providers.filter(providerId => !this.authenticationService.isDynamicAuthenticationProvider(providerId));
		const dynamicProviders = providers.filter(providerId => this.authenticationService.isDynamicAuthenticationProvider(providerId));

		if (!this.initialized) {
			const noAccountsAvailableAction = disposables.add(new Action('noAccountsAvailable', localize('loading', "Loading..."), undefined, false));
			menus.push(noAccountsAvailableAction);
		} else {
			for (const providerId of registeredProviders) {
				const provider = this.authenticationService.getProvider(providerId);
				const accounts = this.groupedAccounts.get(providerId);
				if (!accounts) {
					if (this.problematicProviders.has(providerId)) {
						const providerUnavailableAction = disposables.add(new Action('providerUnavailable', localize('authProviderUnavailable', '{0} is currently unavailable', provider.label), undefined, false));
						menus.push(providerUnavailableAction);
						// try again in the background so that if the failure was intermittent, we can resolve it on the next showing of the menu
						try {
							await this.addAccountsFromProvider(providerId);
						} catch (e) {
							this.logService.error(e);
						}
					}
					continue;
				}

				const canUseMcp = !!provider.authorizationServers?.length;
				for (const account of accounts) {
					const manageExtensionsAction = toAction({
						id: `configureSessions${account.label}`,
						label: localize('manageTrustedExtensions', "Manage Trusted Extensions"),
						enabled: true,
						run: () => this.commandService.executeCommand('_manageTrustedExtensionsForAccount', { providerId, accountLabel: account.label })
					});


					const providerSubMenuActions: IAction[] = [manageExtensionsAction];
					if (canUseMcp) {
						const manageMCPAction = toAction({
							id: `configureSessions${account.label}`,
							label: localize('manageTrustedMCPServers', "Manage Trusted MCP Servers"),
							enabled: true,
							run: () => this.commandService.executeCommand('_manageTrustedMCPServersForAccount', { providerId, accountLabel: account.label })
						});
						providerSubMenuActions.push(manageMCPAction);
					}
					if (account.canSignOut) {
						providerSubMenuActions.push(toAction({
							id: 'signOut',
							label: localize('signOut', "Sign Out"),
							enabled: true,
							run: () => this.commandService.executeCommand('_signOutOfAccount', { providerId, accountLabel: account.label })
						}));
					}

					const providerSubMenu = new SubmenuAction('activitybar.submenu', `${account.label} (${provider.label})`, providerSubMenuActions);
					menus.push(providerSubMenu);
				}
			}

			if (dynamicProviders.length && registeredProviders.length) {
				menus.push(new Separator());
			}

			for (const providerId of dynamicProviders) {
				const provider = this.authenticationService.getProvider(providerId);
				const accounts = this.groupedAccounts.get(providerId);
				// Provide _some_ discoverable way to manage dynamic authentication providers.
				// This will either show up inside the account submenu or as a top-level menu item if there
				// are no accounts.
				const manageDynamicAuthProvidersAction = toAction({
					id: 'manageDynamicAuthProviders',
					label: localize('manageDynamicAuthProviders', "Manage Dynamic Authentication Providers..."),
					enabled: true,
					run: () => this.commandService.executeCommand('workbench.action.removeDynamicAuthenticationProviders')
				});
				if (!accounts) {
					if (this.problematicProviders.has(providerId)) {
						const providerUnavailableAction = disposables.add(new Action('providerUnavailable', localize('authProviderUnavailable', '{0} is currently unavailable', provider.label), undefined, false));
						menus.push(providerUnavailableAction);
						// try again in the background so that if the failure was intermittent, we can resolve it on the next showing of the menu
						try {
							await this.addAccountsFromProvider(providerId);
						} catch (e) {
							this.logService.error(e);
						}
					}
					menus.push(manageDynamicAuthProvidersAction);
					continue;
				}

				for (const account of accounts) {
					// TODO@TylerLeonhardt: Is there a nice way to bring this back?
					// const manageExtensionsAction = toAction({
					// 	id: `configureSessions${account.label}`,
					// 	label: localize('manageTrustedExtensions', "Manage Trusted Extensions"),
					// 	enabled: true,
					// 	run: () => this.commandService.executeCommand('_manageTrustedExtensionsForAccount', { providerId, accountLabel: account.label })
					// });

					const providerSubMenuActions: IAction[] = [];
					const manageMCPAction = toAction({
						id: `configureSessions${account.label}`,
						label: localize('manageTrustedMCPServers', "Manage Trusted MCP Servers"),
						enabled: true,
						run: () => this.commandService.executeCommand('_manageTrustedMCPServersForAccount', { providerId, accountLabel: account.label })
					});
					providerSubMenuActions.push(manageMCPAction);
					providerSubMenuActions.push(manageDynamicAuthProvidersAction);
					if (account.canSignOut) {
						providerSubMenuActions.push(toAction({
							id: 'signOut',
							label: localize('signOut', "Sign Out"),
							enabled: true,
							run: () => this.commandService.executeCommand('_signOutOfAccount', { providerId, accountLabel: account.label })
						}));
					}

					const providerSubMenu = new SubmenuAction('activitybar.submenu', `${account.label} (${provider.label})`, providerSubMenuActions);
					menus.push(providerSubMenu);
				}
			}
		}

		const codexAccountActions = createCodexAccountMenuActions(this.codexAccountService, shouldShowCodexAccount(this.configurationService, false));
		if (codexAccountActions.length) {
			if (menus.length) {
				menus.push(new Separator());
			}
			for (const action of codexAccountActions) {
				menus.push(action instanceof Action ? disposables.add(action) : action);
			}
		}

		if (menus.length && otherCommands.length) {
			menus.push(new Separator());
		}

		otherCommands.forEach((group, i) => {
			const actions = group[1];
			menus = menus.concat(actions);
			if (i !== otherCommands.length - 1) {
				menus.push(new Separator());
			}
		});

		return menus;
	}

	protected override async resolveContextMenuActions(disposables: DisposableStore): Promise<IAction[]> {
		const actions = await super.resolveContextMenuActions(disposables);
		this.fillContextMenuActions(actions);
		return actions;
	}

	//#endregion

	//#region groupedAccounts helpers

	private async addOrUpdateAccount(providerId: string, account: AuthenticationSessionAccount): Promise<void> {
		let accounts = this.groupedAccounts.get(providerId);
		if (!accounts) {
			accounts = [];
			this.groupedAccounts.set(providerId, accounts);
		}

		const sessionFromEmbedder = await this.sessionFromEmbedder.value;
		let canSignOut = true;
		if (
			sessionFromEmbedder												// if we have a session from the embedder
			&& !sessionFromEmbedder.canSignOut								// and that session says we can't sign out
			&& (await this.authenticationService.getSessions(providerId))	// and that session is associated with the account we are adding/updating
				.some(s =>
					s.id === sessionFromEmbedder.id
					&& s.account.id === account.id
				)
		) {
			canSignOut = false;
		}

		const existingAccount = accounts.find(a => a.label === account.label);
		if (existingAccount) {
			// if we have an existing account and we discover that we
			// can't sign out of it, update the account to mark it as "can't sign out"
			if (!canSignOut) {
				existingAccount.canSignOut = canSignOut;
			}
			existingAccount.icon = account.icon;
		} else {
			accounts.push({ ...account, canSignOut });
		}
	}

	private removeAccount(providerId: string, account: AuthenticationSessionAccount): void {
		const accounts = this.groupedAccounts.get(providerId);
		if (!accounts) {
			return;
		}

		const index = accounts.findIndex(a => a.id === account.id);
		if (index === -1) {
			return;
		}

		accounts.splice(index, 1);
		if (accounts.length === 0) {
			this.groupedAccounts.delete(providerId);
		}
	}

	private async addAccountsFromProvider(providerId: string): Promise<void> {
		try {
			const sessions = await this.authenticationService.getSessions(providerId);
			this.problematicProviders.delete(providerId);

			for (const session of sessions) {
				try {
					await this.addOrUpdateAccount(providerId, session.account);
				} catch (e) {
					this.logService.error(e);
				}
			}
		} catch (e) {
			this.logService.error(e);
			this.problematicProviders.add(providerId);
		}
	}

	//#endregion
}

export class GlobalActivityActionViewItem extends AbstractGlobalActivityActionViewItem {

	private profileBadge: HTMLElement | undefined;
	private profileBadgeContent: HTMLElement | undefined;

	constructor(
		contextMenuActionsProvider: () => IAction[],
		options: ICompositeBarActionViewItemOptions,
		contextMenuAlignmentOptions: () => Readonly<{ anchorAlignment: AnchorAlignment; anchorAxisAlignment: AnchorAxisAlignment }> | undefined,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IActivityService activityService: IActivityService,
	) {
		const action = instantiationService.createInstance(CompositeBarAction, {
			id: GLOBAL_ACTIVITY_ID,
			name: localize('manage', "Manage"),
			classNames: ThemeIcon.asClassNameArray(userDataProfileService.currentProfile.icon ? ThemeIcon.fromId(userDataProfileService.currentProfile.icon) : DEFAULT_ICON)
		});
		super(MenuId.GlobalActivity, action, options, contextMenuActionsProvider, contextMenuAlignmentOptions, themeService, hoverService, menuService, contextMenuService, contextKeyService, configurationService, keybindingService, activityService);
		this._register(action);
		this._register(this.userDataProfileService.onDidChangeCurrentProfile(e => {
			action.compositeBarActionItem = {
				...action.compositeBarActionItem,
				classNames: ThemeIcon.asClassNameArray(userDataProfileService.currentProfile.icon ? ThemeIcon.fromId(userDataProfileService.currentProfile.icon) : DEFAULT_ICON)
			};
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this.profileBadge = append(container, $('.profile-badge'));
		this.profileBadgeContent = append(this.profileBadge, $('.profile-badge-content'));
		this.updateProfileBadge();
	}

	private updateProfileBadge(): void {
		if (!this.profileBadge || !this.profileBadgeContent) {
			return;
		}

		clearNode(this.profileBadgeContent);
		hide(this.profileBadge);

		if (this.userDataProfileService.currentProfile.isDefault) {
			return;
		}

		if (this.userDataProfileService.currentProfile.icon && this.userDataProfileService.currentProfile.icon !== DEFAULT_ICON.id) {
			return;
		}

		if ((this.action as CompositeBarAction).activities.length > 0) {
			return;
		}

		show(this.profileBadge);
		this.profileBadgeContent.classList.add('profile-text-overlay');
		this.profileBadgeContent.textContent = this.userDataProfileService.currentProfile.name.substring(0, 2).toUpperCase();
	}

	protected override updateActivity(): void {
		super.updateActivity();
		this.updateProfileBadge();
	}

	protected override computeTitle(): string {
		return this.userDataProfileService.currentProfile.isDefault ? super.computeTitle() : localize('manage profile', "Manage {0} (Profile)", this.userDataProfileService.currentProfile.name);
	}
}

export class SimpleAccountActivityActionViewItem extends AccountsActivityActionViewItem {

	constructor(
		hoverOptions: IActivityHoverOptions,
		options: IBaseActionViewItemOptions,
		@IThemeService themeService: IThemeService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IHoverService hoverService: IHoverService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IAuthenticationService authenticationService: IAuthenticationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IStorageService storageService: IStorageService,
		@ILogService logService: ILogService,
		@IActivityService activityService: IActivityService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService commandService: ICommandService,
		@ICodexAccountService codexAccountService: ICodexAccountService,
		@IDefaultAccountService defaultAccountService: IDefaultAccountService,
	) {
		super(() => simpleActivityContextMenuActions(storageService, true),
			{
				...options,
				colors: theme => ({
					badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
					badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				}),
				hoverOptions,
				compact: true,
			}, () => undefined, actions => actions, themeService, lifecycleService, hoverService, contextMenuService, menuService, contextKeyService, authenticationService, environmentService, productService, configurationService, keybindingService, secretStorageService, logService, activityService, instantiationService, commandService, codexAccountService, defaultAccountService);
	}
}

export class SimpleGlobalActivityActionViewItem extends GlobalActivityActionViewItem {

	constructor(
		hoverOptions: IActivityHoverOptions,
		options: IBaseActionViewItemOptions,
		@IUserDataProfileService userDataProfileService: IUserDataProfileService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMenuService menuService: IMenuService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IActivityService activityService: IActivityService,
		@IStorageService storageService: IStorageService
	) {
		super(() => simpleActivityContextMenuActions(storageService, false),
			{
				...options,
				colors: theme => ({
					badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
					badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				}),
				hoverOptions,
				compact: true,
			}, () => undefined, userDataProfileService, themeService, hoverService, menuService, contextMenuService, contextKeyService, configurationService, environmentService, keybindingService, instantiationService, activityService);
	}
}

function simpleActivityContextMenuActions(storageService: IStorageService, isAccount: boolean): IAction[] {
	const currentElementContextMenuActions: IAction[] = [];
	if (isAccount) {
		currentElementContextMenuActions.push(
			toAction({ id: 'hideAccounts', label: localize('hideAccounts', "Hide Accounts"), run: () => setAccountsActionVisible(storageService, false) }),
			new Separator()
		);
	}
	return [
		...currentElementContextMenuActions,
		toAction({ id: 'toggle.hideAccounts', label: localize('accounts', "Accounts"), checked: isAccountsActionVisible(storageService), run: () => setAccountsActionVisible(storageService, !isAccountsActionVisible(storageService)) }),
		toAction({ id: 'toggle.hideManage', label: localize('manage', "Manage"), checked: true, enabled: false, run: () => { throw new Error('"Manage" can not be hidden'); } })
	];
}

export function isAccountsActionVisible(storageService: IStorageService): boolean {
	return storageService.getBoolean(AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY, StorageScope.PROFILE, true);
}

function setAccountsActionVisible(storageService: IStorageService, visible: boolean) {
	storageService.store(AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY, visible, StorageScope.PROFILE, StorageTarget.USER);
}
