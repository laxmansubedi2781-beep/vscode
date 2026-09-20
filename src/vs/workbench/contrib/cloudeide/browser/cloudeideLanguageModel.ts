/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import {
	ChatMessageRole,
	IChatMessage,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatResponse,
	ILanguageModelsService,
	IChatResponsePart,
} from '../../chat/common/languageModels.js';
import { ChatMessage, CloudeideClient } from './cloudeideClient.js';

const VENDOR = 'cloudeide';
const MODEL_ID = 'cloudeide-agent';

/**
 * Presents the CloudeIDE server as a language model to the rest of the
 * workbench.
 *
 * The panel already talks to `/ai/chat` directly, and for answering a question
 * that is enough. It is not enough for anything that has to *act*: the agent
 * host, the chat view and every tool-using surface in this fork take their
 * model from `ILanguageModelsService` and will not look anywhere else. Putting
 * the server behind that interface is what lets those surfaces run on this
 * account instead of on a key the person has to supply themselves.
 *
 * Text only, for now. The server streams `text` frames and nothing else, so
 * this advertises no tool support; a model that claimed tools it cannot call
 * would fail at the first tool call rather than at selection time.
 */
export class CloudeideLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(private readonly client: CloudeideClient) {
		super();
	}

	async provideLanguageModelChatInfo(): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		// Advertised whether or not a token is stored. Selection happens long
		// before a request does, and a model that vanishes when the token is
		// missing would take the CloudeIDE entry out of the picker rather than
		// explain itself — the request is where "not connected" belongs.
		return [{
			identifier: MODEL_ID,
			metadata: {
				extension: new ExtensionIdentifier('cloudeide'),
				id: MODEL_ID,
				vendor: VENDOR,
				name: 'CloudeIDE',
				family: 'cloudeide',
				version: '1',
				// The server decides the model and its limits; these are the
				// figures the workbench needs for trimming, not a promise.
				maxInputTokens: 180_000,
				maxOutputTokens: 16_000,
				isDefaultForLocation: { [ChatAgentLocation.Chat]: true },
				isUserSelectable: true,
			},
		}];
	}

	async sendChatRequest(
		_modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		_options: unknown,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		// The workbench's message shape is richer than the server's: parts can
		// be images, tool calls or thinking. Only text survives the trip, and
		// system messages are hoisted out because `/ai/chat` takes them in a
		// field of their own rather than in the list.
		const system: string[] = [];
		const history: ChatMessage[] = [];
		for (const message of messages) {
			const text = message.content
				.filter(part => part.type === 'text')
				.map(part => (part as { value: string }).value)
				.join('');
			if (!text) {
				continue;
			}
			if (message.role === ChatMessageRole.System) {
				system.push(text);
			} else {
				history.push({
					role: message.role === ChatMessageRole.Assistant ? 'assistant' : 'user',
					content: text,
				});
			}
		}

		// A queue rather than a callback chain: `chat` hands text to a callback
		// as it arrives, and the caller wants an async iterable. This bridges
		// the two without buffering the whole answer first, so the stream stays
		// a stream.
		const chunks: string[] = [];
		let notify: (() => void) | undefined;
		let finished = false;
		let failure: unknown;

		const wake = () => {
			notify?.();
			notify = undefined;
		};

		const result = this.client
			.chat(history, chunk => { chunks.push(chunk); wake(); }, system.join('\n\n') || undefined)
			.then(() => { finished = true; wake(); })
			.catch(err => { failure = err; finished = true; wake(); });

		const stream = (async function* (): AsyncIterable<IChatResponsePart> {
			while (true) {
				while (chunks.length > 0) {
					if (token.isCancellationRequested) {
						return;
					}
					yield { type: 'text', value: chunks.shift()! } satisfies IChatResponsePart;
				}
				if (finished) {
					if (failure) {
						throw failure;
					}
					return;
				}
				await new Promise<void>(resolve => { notify = resolve; });
			}
		})();

		return { stream, result };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage): Promise<number> {
		// An estimate, and named as one. The server does not expose a tokenizer
		// and the workbench only uses this to decide what to trim, so four
		// characters to a token — the usual rough figure — is closer than
		// refusing to answer.
		const text = typeof message === 'string'
			? message
			: message.content.filter(p => p.type === 'text').map(p => (p as { value: string }).value).join('');
		return Math.ceil(text.length / 4);
	}
}

/**
 * Registers the provider once the workbench is up.
 */
export class CloudeideLanguageModelContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideLanguageModel';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super();

		// The vendor has to exist before a provider can claim it; registering a
		// provider for an unknown vendor throws.
		languageModelsService.deltaLanguageModelChatProviderDescriptors(
			// The schema derives its type from a JSON schema where every
			// optional field is still present, so they are named rather than
			// omitted.
			[{ vendor: VENDOR, displayName: 'CloudeIDE', configuration: undefined, managementCommand: undefined, when: undefined }],
			[],
		);

		const client = new CloudeideClient(secretStorageService, configurationService);
		const provider = this._register(new CloudeideLanguageModelProvider(client));

		try {
			this._register(languageModelsService.registerLanguageModelProvider(VENDOR, provider));
		} catch (error) {
			logService.error('[CloudeIDE] could not register the language model provider', error);
		}
	}
}
