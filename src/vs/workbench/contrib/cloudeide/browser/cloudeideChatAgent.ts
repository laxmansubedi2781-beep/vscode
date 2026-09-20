/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import {
	IChatAgentData,
	IChatAgentHistoryEntry,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentService,
} from '../../chat/common/participants/chatAgents.js';
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ChatMessage, CloudeideClient } from './cloudeideClient.js';

const AGENT_ID = 'cloudeide.agent';

/**
 * The agent behind the chat panel.
 *
 * Chat needs two things and only had one. A language model is registered
 * against the server, but a model is not an agent: the panel hands a request
 * to a participant, and the participant this fork inherited came from the
 * Copilot extension that no longer ships. Without one, sending did nothing at
 * all — no turn, no error, with a mouse and with touch alike.
 *
 * This is that participant. It answers from the same server the CloudeIDE
 * panel uses, so one account and one token serve both surfaces.
 *
 * Text, for now, and the limit is the server's rather than this file's:
 * `/ai/chat` streams text frames and has no way to ask for a tool call. The
 * tools the panel already lists — read, execute, agent, todo — are wired to
 * the workbench and waiting; what is missing is a server that can say "call
 * this one". That is the next piece, and it is not claimed here.
 */
class CloudeideAgent implements IChatAgentImplementation {

	constructor(
		private readonly client: CloudeideClient,
		private readonly editorService: IEditorService,
		private readonly modelService: IModelService,
	) { }

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const messages: ChatMessage[] = [];
		for (const entry of history) {
			if (entry.request.message) {
				messages.push({ role: 'user', content: entry.request.message });
			}
			const answer = entry.response
				.map(part => (part.kind === 'markdownContent' ? part.content.value : ''))
				.join('');
			if (answer) {
				messages.push({ role: 'assistant', content: answer });
			}
		}
		messages.push({ role: 'user', content: request.message });

		try {
			await this.client.chat(messages, chunk => {
				if (token.isCancellationRequested) {
					return;
				}
				progress([{ kind: 'markdownContent', content: new MarkdownString(chunk) }]);
			}, this.context());
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Reported as the answer rather than thrown. A thrown error here is
			// rendered as an internal failure; this is usually "not connected",
			// which is something the person can act on.
			progress([{ kind: 'markdownContent', content: new MarkdownString(message) }]);
			return { errorDetails: { message } };
		}

		return {};
	}

	/**
	 * The file in front of the person, sent as the system prompt.
	 *
	 * The same reasoning as the CloudeIDE panel's: filmed without it, the
	 * model answered a question about an open file by asking for the file to
	 * be pasted. Read from the editor's model rather than from disk, so an
	 * unsaved buffer is the copy that travels.
	 */
	private context(): string | undefined {
		const active = this.editorService.activeEditor?.resource;
		if (!active) {
			return undefined;
		}
		const text = this.modelService.getModel(active)?.getValue();
		if (!text) {
			return undefined;
		}
		const clipped = text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated)` : text;
		return [
			'You are CloudeIDE, helping inside the editor the person is working in.',
			`The file they are looking at is ${active.path}:`,
			'```',
			clipped,
			'```',
		].join('\n');
	}
}

export class CloudeideChatAgentContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideChatAgent';

	constructor(
		@IChatAgentService agentService: IChatAgentService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditorService editorService: IEditorService,
		@IModelService modelService: IModelService,
	) {
		super();

		const data: IChatAgentData = {
			id: AGENT_ID,
			name: 'CloudeIDE',
			fullName: 'CloudeIDE',
			description: localize('cloudeide.agent.description', "Ask about the code you have open, and ship it."),
			// Registered from the workbench rather than contributed by an
			// extension, which is what `isCore` says and why the identifier
			// is not an extension that exists.
			extensionId: new ExtensionIdentifier('cloudeide'),
			extensionVersion: undefined,
			extensionPublisherId: 'cloudeide',
			publisherDisplayName: 'CloudeIDE',
			extensionDisplayName: 'CloudeIDE',
			isDefault: true,
			isCore: true,
			metadata: {},
			slashCommands: [],
			locations: [ChatAgentLocation.Chat],
			// Ask only, and honestly so: Edit and Agent promise the model can
			// change files, and this one can only answer.
			modes: [ChatModeKind.Ask],
			disambiguation: [],
		};

		this._register(agentService.registerAgent(AGENT_ID, data));

		const client = new CloudeideClient(secretStorageService, configurationService);
		this._register(agentService.registerAgentImplementation(
			AGENT_ID,
			new CloudeideAgent(client, editorService, modelService),
		));
	}
}
