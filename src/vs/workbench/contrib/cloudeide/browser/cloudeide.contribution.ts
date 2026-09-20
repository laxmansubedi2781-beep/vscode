/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import './media/cloudeide.css';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewDescriptor,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../common/views.js';
import { CloudeidePanel } from './cloudeidePanel.js';
import { CloudeideLanguageModelContribution } from './cloudeideLanguageModel.js';
import { CloudeideChatAgentContribution } from './cloudeideChatAgent.js';
import { CloudeideSignInContribution } from './cloudeideSignIn.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AgentHostAnthropicKeySecret } from '../../../../platform/agentHost/common/agentService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const CONTAINER_ID = 'workbench.view.cloudeideContainer';

const cloudeideIcon = registerIcon(
	'cloudeide-view-icon',
	Codicon.rocket,
	localize('cloudeideViewIcon', "View icon of the CloudeIDE panel."),
);

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
			title: localize2('cloudeide', "CloudeIDE"),
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
	name: localize2('cloudeide', "CloudeIDE"),
	containerIcon: cloudeideIcon,
	ctorDescriptor: new SyncDescriptor(CloudeidePanel),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: 'workbench.action.cloudeide.focus',
		title: localize2('cloudeide.focus', "Focus CloudeIDE"),
	},
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([viewDescriptor], container);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'cloudeide',
	title: localize('cloudeide.settings', "CloudeIDE"),
	type: 'object',
	properties: {
		'cloudeide.serverUrl': {
			type: 'string',
			default: 'https://api.cloudeide.com',
			description: localize('cloudeide.serverUrl',
				"The CloudeIDE server this editor talks to. Change it to point at a self-hosted install."),
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
 * The door, before the editor. BlockRestore rather than AfterRestored: a
 * sign-in screen that fades in a second after the workbench has already
 * painted reads as something that went wrong, not as the way in.
 */
registerWorkbenchContribution2(
	CloudeideSignInContribution.ID,
	CloudeideSignInContribution,
	WorkbenchPhase.BlockRestore,
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
