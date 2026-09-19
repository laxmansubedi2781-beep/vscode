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
			default: 'https://cloudeide.com',
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
