/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * Talks to a CloudeIDE server.
 *
 * Deliberately small: two things the editor cannot do on its own — ask the
 * model, and put the project live. Everything else the editor already does
 * better than a panel could.
 *
 * The token is a CloudeIDE API token (`cide_…`), the same credential the CLI
 * uses, held in secret storage rather than settings so it never lands in a
 * synced settings file or a screenshot of one.
 */

const TOKEN_KEY = 'cloudeide.apiToken';
const PROJECT_KEY = 'cloudeide.projectId';

export interface ChatMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
}

export interface DeployResult {
	readonly id: number;
	readonly status: string;
	readonly url?: string;
}

export class CloudeideRequestError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export class CloudeideClient {

	constructor(
		private readonly secretStorageService: ISecretStorageService,
		private readonly storageService: IStorageService,
		private readonly configurationService: IConfigurationService,
	) { }

	get serverUrl(): string {
		const configured = this.configurationService.getValue<string>('cloudeide.serverUrl');
		return (configured || 'https://cloudeide.com').replace(/\/+$/, '');
	}

	async getToken(): Promise<string | undefined> {
		return this.secretStorageService.get(TOKEN_KEY);
	}

	async setToken(token: string): Promise<void> {
		await this.secretStorageService.set(TOKEN_KEY, token);
	}

	async clearToken(): Promise<void> {
		await this.secretStorageService.delete(TOKEN_KEY);
	}

	get projectId(): string | undefined {
		return this.storageService.get(PROJECT_KEY, StorageScope.WORKSPACE);
	}

	set projectId(id: string | undefined) {
		if (id) {
			this.storageService.store(PROJECT_KEY, id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(PROJECT_KEY, StorageScope.WORKSPACE);
		}
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const token = await this.getToken();
		if (!token) {
			throw new CloudeideRequestError('Not connected to CloudeIDE.', 401);
		}

		// Aborted rather than left hanging: a request the editor is still
		// waiting on after half a minute is one the person has given up on.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 120_000);

		let response: Response;
		try {
			response = await fetch(`${this.serverUrl}/api${path}`, {
				...init,
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`,
					...(init.headers as Record<string, string> ?? {}),
				},
			});
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof DOMException && err.name === 'AbortError') {
				throw new CloudeideRequestError('The server took too long to answer.', 0);
			}
			throw new CloudeideRequestError(`Could not reach ${this.serverUrl}.`, 0);
		}
		clearTimeout(timer);

		if (!response.ok) {
			// The server's own message where there is one. Its refusals say what
			// to do about them — "You are out of credits", "Add a seat" — and
			// replacing that with a status code helps nobody.
			let message = `Request failed (${response.status}).`;
			try {
				const body = await response.json() as { error?: unknown };
				if (typeof body?.error === 'string') {
					message = body.error;
				}
			} catch {
				// Not JSON. Keep the status-based message.
			}
			throw new CloudeideRequestError(message, response.status);
		}

		if (response.status === 204) {
			return undefined as T;
		}
		return await response.json() as T;
	}

	/** Confirms the token works, and returns who it belongs to. */
	async whoami(): Promise<{ email: string }> {
		return this.request<{ email: string }>('/user/me');
	}

	async chat(messages: readonly ChatMessage[], system?: string): Promise<string> {
		const body = await this.request<{ content?: string; message?: string }>('/ai/chat', {
			method: 'POST',
			body: JSON.stringify({ messages, system }),
		});
		return body.content ?? body.message ?? '';
	}

	async listProjects(): Promise<{ id: number; name: string }[]> {
		const body = await this.request<{ projects?: { id: number; name: string }[] }>('/deploy/projects');
		return body.projects ?? [];
	}

	async deploy(projectId: string, files: { path: string; content: string }[]): Promise<DeployResult> {
		return this.request<DeployResult>('/deploy/deployments', {
			method: 'POST',
			body: JSON.stringify({ projectId, files, trigger: 'manual' }),
		});
	}

	async deploymentStatus(id: number): Promise<DeployResult> {
		return this.request<DeployResult>(`/deploy/deployments/${id}`);
	}
}
