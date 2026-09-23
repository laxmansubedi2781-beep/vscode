/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import './media/cloudeide.css';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { FileAccess } from '../../../../base/common/network.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../common/views.js';
import { CloudeidePanel } from './cloudeidePanel.js';
import { CloudeideClient } from './cloudeideClient.js';
import { CloudeideCloudPanel } from './cloudeideCloudPanel.js';
import { CloudeideAccountPanel } from './cloudeideAccountPanel.js';
import { CloudeideLanguageModelContribution } from './cloudeideLanguageModel.js';
import { CloudeideChatAgentContribution } from './cloudeideChatAgent.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AgentHostAnthropicKeySecret, CloudeideTokenSecret } from '../../../../platform/agentHost/common/agentService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const CONTAINER_ID = 'workbench.view.cloudeideContainer';

/*
 * The product's own mark, not a codicon standing in for it.
 *
 * A URI icon is applied as a CSS mask rather than drawn, so the white fill in
 * the file never reaches the screen — the shape is cut out of the theme's own
 * foreground colour. That is what makes shipping a brand mark here safe: it
 * follows a light theme the same way every other icon in the bar does.
 */
const cloudeideIcon = FileAccess.asBrowserUri('vs/workbench/contrib/cloudeide/browser/media/logo.svg');

/*
 * The auxiliary bar — the right-hand side — rather than the primary sidebar.
 *
 * The left side already holds the things a person navigates *with*: files,
 * search, source control. This panel is something they work *alongside*, with
 * the editor still visible, which is the auxiliary bar's whole purpose. It is
 * also where every comparable panel has settled, so muscle memory carries over.
 */
const container = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
	.registerViewContainer(
		{
			id: CONTAINER_ID,
			// "Agent", not the product name.
			//
			// This string is what the panel's header shows, and the brand was
			// already on screen four times over — title bar, activity bar
			// icon, the Welcome page, the composer's own placeholder. A panel
			// header is a label for what the pane *is*, which is the same
			// reason the one on the left says Explorer and not the name of
			// the editor. It still answers to "CloudeIDE" everywhere a person
			// searches for it: the command is Focus CloudeIDE, below.
			title: localize2('cloudeide.container', "Chat"),
			icon: cloudeideIcon,
			ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
			storageId: CONTAINER_ID,
			order: 1,
		},
		ViewContainerLocation.AuxiliaryBar,
		{ isDefault: true },
	);

const viewDescriptor: IViewDescriptor = {
	id: CloudeidePanel.ID,
	name: localize2('cloudeide.view', "Chat"),
	containerIcon: cloudeideIcon,
	ctorDescriptor: new SyncDescriptor(CloudeidePanel),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: 'workbench.action.cloudeide.focus',
		title: localize2('cloudeide.focus', "Focus CloudeIDE"),
	},
};

/*
 * The second pane, under the chat.
 *
 * `mergeViewWithContainerWhenSingleView` on the container above means one view
 * renders without a header; two render as stacked panes with their own, which
 * is what this wants — the chat is what somebody looks at all day and Cloud is
 * what they open when they are ready to ship, so it starts collapsed and the
 * workbench remembers whatever they do to it after that.
 */
const cloudViewDescriptor: IViewDescriptor = {
	id: CloudeideCloudPanel.ID,
	name: localize2('cloudeide.cloud', "Cloud"),
	containerIcon: cloudeideIcon,
	ctorDescriptor: new SyncDescriptor(CloudeideCloudPanel),
	canToggleVisibility: true,
	canMoveView: true,
	collapsed: true,
	// Off the panel by default. See the note on the Account view below.
	hideByDefault: true,
	order: 2,
	openCommandActionDescriptor: {
		id: 'workbench.action.cloudeide.cloud.focus',
		title: localize2('cloudeide.cloud.focus', "Focus CloudeIDE Cloud"),
	},
};

/*
 * The third pane, and the one opened least.
 *
 * Who the account is, what the plan allows and what is left of it — all of
 * which was a page on the web, so "how many credits do I have" meant opening
 * a different application. Collapsed like Cloud: it answers a question rather
 * than being worked in.
 */
const accountViewDescriptor: IViewDescriptor = {
	id: CloudeideAccountPanel.ID,
	name: localize2('cloudeide.account', "Account"),
	containerIcon: cloudeideIcon,
	ctorDescriptor: new SyncDescriptor(CloudeideAccountPanel),
	canToggleVisibility: true,
	canMoveView: true,
	collapsed: true,
	/*
	 * Off the panel by default, along with Cloud.
	 *
	 * A new person opening this saw three stacked pane headers before they
	 * saw anything they could type into. The panel is for one thing, and the
	 * other two are things you go and look at rather than things you work
	 * beside.
	 *
	 * Hidden rather than unregistered, because this pane is the only way to
	 * sign out, see what a plan costs, or revoke a token, and Cloud is the
	 * only way to deploy. Taking those off the panel is a layout decision;
	 * taking them out of the product is not, and is not what was asked for.
	 * Both are one click away in the panel's ... menu, and the workbench
	 * remembers it once somebody turns one back on.
	 */
	hideByDefault: true,
	order: 3,
	openCommandActionDescriptor: {
		id: 'workbench.action.cloudeide.account.focus',
		title: localize2('cloudeide.account.focus', "Focus CloudeIDE Account"),
	},
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry)
	.registerViews([viewDescriptor, cloudViewDescriptor, accountViewDescriptor], container);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'cloudeide',
	title: localize('cloudeide.settings', "CloudeIDE"),
	type: 'object',
	properties: {
		'cloudeide.serverUrl': {
			type: 'string',
			default: 'https://cloudeide.com',
			description: localize('cloudeide.serverUrl',
				"The CloudeIDE server this editor talks to. Change it to point at a self-hosted install."),
		},
		'cloudeide.webUrl': {
			type: 'string',
			default: 'https://cloudeide.com',
			description: localize('cloudeide.webUrl',
				"The CloudeIDE dashboard this editor opens to sign in. The same host as the server URL unless you have split them. Change both together for a self-hosted install."),
		},
		'cloudeide.model': {
			type: 'string',
			enum: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna'],
			default: 'claude-sonnet-5',
			enumDescriptions: [
				localize('cloudeide.model.sonnet', "The default. Strong at code, and the one most coding turns should use."),
				localize('cloudeide.model.opus', "The most capable, and the most expensive per turn. For a change that has defeated the default."),
				localize('cloudeide.model.haiku', "The cheapest and quickest. Good for a question, thin for a refactor."),
				localize('cloudeide.model.terra', "OpenAI's middle model."),
				localize('cloudeide.model.sol', "OpenAI's most capable."),
				localize('cloudeide.model.luna', "OpenAI's cheapest."),
			],
			description: localize('cloudeide.model',
				"Which model the agent runs on. Every model here is billed to your CloudeIDE account, and what a turn costs depends on which one you pick — see Credits in the dashboard."),
		},
		'cloudeide.environment': {
			type: 'string',
			enum: ['development', 'preview', 'production'],
			default: 'development',
			scope: 5 /* ConfigurationScope.RESOURCE */,
			enumDescriptions: [
				localize('cloudeide.environment.development', "A throwaway URL for checking a change."),
				localize('cloudeide.environment.preview', "A shareable URL for review."),
				localize('cloudeide.environment.production', "The live site."),
			],
			description: localize('cloudeide.environment',
				"Where the Deploy button publishes. It starts at development so a first press cannot replace a live site."),
		},
		'cloudeide.projectId': {
			type: 'string',
			default: '',
			scope: 5 /* ConfigurationScope.RESOURCE */,
			description: localize('cloudeide.projectId',
				"Which CloudeIDE project to deploy to. Leave empty unless the account has more than one — the server picks the default."),
		},
	},
});

/*
 * The server, offered to the rest of the workbench as a language model.
 *
 * The panel calls `/ai/chat` itself and that is enough to answer a question.
 * It is not enough for anything that has to act on the answer: the agent host
 * and every tool-using surface here take their model from
 * `ILanguageModelsService`. Registering it after restore keeps it off the
 * startup path — nothing needs a model before the window is up.
 */
registerWorkbenchContribution2(
	CloudeideLanguageModelContribution.ID,
	CloudeideLanguageModelContribution,
	WorkbenchPhase.AfterRestored,
);

/*
 * The participant behind the chat panel. Without one, chat has nobody to
 * hand a request to and sending does nothing at all — no turn, no error.
 */
registerWorkbenchContribution2(
	CloudeideChatAgentContribution.ID,
	CloudeideChatAgentContribution,
	WorkbenchPhase.AfterRestored,
);

/*
 * Bring your own key.
 *
 * The Claude harness in this fork is a complete coding agent — read, write,
 * edit, run, undo — and it has never had a credential to run on. It reads
 * ANTHROPIC_API_KEY from its own environment, which until now meant exporting
 * one in a login shell before launching the app and explaining that to every
 * person who installs it.
 *
 * This is the other end of that: the key goes into secret storage here, and
 * the agent host picks it up from the main process at spawn. It is never
 * written to settings, never to disk in the clear, and never leaves the
 * machine.
 *
 * The window has to reload because the environment of a spawned process is
 * fixed when it spawns. Asking is better than doing it underneath someone
 * with unsaved work.
 */
/*
 * Signing in with a token, for the two callers that cannot use a browser.
 *
 * The door hands somebody to cloudeide.com and takes the answer back through
 * a `cloudeide://` URL, which is the right flow for a person and impossible
 * for two others: a CI run filming the product, and anyone on a machine with
 * no browser to hand — a server, a container, a remote session.
 *
 * Not a back door. It stores the same secret the door stores, checks it
 * against the server before saying it worked, and is reachable only from the
 * command palette, where somebody has to go looking for it.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudeide.signInWithToken',
			title: localize2('cloudeide.signInWithToken', "CloudeIDE: Sign In with an API Token"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const secrets = accessor.get(ISecretStorageService);
		const dialogs = accessor.get(IDialogService);
		const configuration = accessor.get(IConfigurationService);

		const token = await quickInput.input({
			password: true,
			ignoreFocusLost: true,
			placeHolder: 'cide_…',
			prompt: localize('cloudeide.signInWithToken.prompt', "Paste a CloudeIDE API token from Settings → API tokens."),
		});
		if (token === undefined) {
			return;
		}

		const trimmed = token.trim();
		if (!trimmed) {
			await secrets.delete(CloudeideTokenSecret);
			return;
		}

		// Proved before it is kept. A token that is only stored fails later,
		// mid-question, where it reads as the product being broken.
		const client = new CloudeideClient(secrets, configuration);
		await client.setToken(trimmed);
		try {
			const me = await client.whoami();
			await dialogs.info(
				localize('cloudeide.signInWithToken.ok', "Signed in as {0}", me.email),
				localize('cloudeide.signInWithToken.okDetail', "Open the CloudeIDE panel to ask something."),
			);
		} catch (err) {
			await client.clearToken();
			await dialogs.error(
				localize('cloudeide.signInWithToken.failed', "That token did not work"),
				err instanceof Error ? err.message : String(err),
			);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'cloudeide.setAnthropicKey',
			title: localize2('cloudeide.setAnthropicKey', "CloudeIDE: Use My Anthropic API Key"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const secrets = accessor.get(ISecretStorageService);
		const dialogs = accessor.get(IDialogService);
		const commands = accessor.get(ICommandService);

		const key = await quickInput.input({
			password: true,
			ignoreFocusLost: true,
			placeHolder: 'sk-ant-…',
			prompt: localize('cloudeide.setAnthropicKey.prompt', "Paste an Anthropic API key. It is stored on this machine only, and lets the agent read, write and run code."),
		});
		if (key === undefined) {
			return;
		}

		const trimmed = key.trim();
		if (trimmed) {
			await secrets.set(AgentHostAnthropicKeySecret, trimmed);
		} else {
			// An empty box clears the key rather than storing nothing, which
			// is the only way back to the shell's own credential.
			await secrets.delete(AgentHostAnthropicKeySecret);
		}

		const { confirmed } = await dialogs.confirm({
			message: trimmed
				? localize('cloudeide.setAnthropicKey.saved', "Key saved. Reload the window to start the agent with it?")
				: localize('cloudeide.setAnthropicKey.cleared', "Key cleared. Reload the window to stop the agent using it?"),
			detail: localize('cloudeide.setAnthropicKey.detail', "The agent reads its credential when it starts, so this takes effect after a reload."),
			primaryButton: localize('cloudeide.setAnthropicKey.reload', "Reload"),
		});
		if (confirmed) {
			await commands.executeCommand('workbench.action.reloadWindow');
		}
	}
});
