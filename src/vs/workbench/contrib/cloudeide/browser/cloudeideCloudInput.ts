/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Cloud tab's identity.
 *
 * Cloud used to be a pane stacked under the chat, about three hundred pixels
 * wide. Everything it has to show is a table — deployments with times and
 * commits, domains with a status and a DNS record to copy — and a table in a
 * sidebar is a column of wrapped fragments. So it moved into the editor area,
 * where Settings, Welcome and the Extensions detail page already live, and
 * where it has the width its content needs.
 *
 * One tab, not one per press. `Singleton` tells the workbench that, and
 * `matches` makes a second open find the first — otherwise every press of the
 * Cloud button opens another identical tab, which is how the Settings editor
 * used to behave and why nobody liked it.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export class CloudeideCloudInput extends EditorInput {

	static readonly ID = 'workbench.editors.cloudeideCloud';

	private static instance: CloudeideCloudInput | undefined;

	readonly resource = undefined;

	static getOrCreate(): CloudeideCloudInput {
		if (!CloudeideCloudInput.instance || CloudeideCloudInput.instance.isDisposed()) {
			CloudeideCloudInput.instance = new CloudeideCloudInput();
		}
		return CloudeideCloudInput.instance;
	}

	override get typeId(): string {
		return CloudeideCloudInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly;
	}

	override getName(): string {
		return localize('cloudeide.cloud.tab', "Cloud");
	}

	override getIcon(): ThemeIcon {
		return Codicon.cloud;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof CloudeideCloudInput;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
