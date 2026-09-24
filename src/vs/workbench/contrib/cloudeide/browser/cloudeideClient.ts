/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { CloudeideDefaultServerUrl, CloudeideTokenSecret } from '../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * Talks to a CloudeIDE server.
 *
 * Deliberately small: two things the editor cannot do on its own — ask the
 * model, and put the project live. Everything else the editor already does
 * better than a panel could.
 *
 * Every route and payload here is the one the server actually serves. An
 * earlier version of this file invented `/user/me` and `/deploy/deployments`
 * and parsed the chat reply as JSON, and it all passed against a stand-in
 * server written from the same wrong assumptions. The stand-in is not the
 * contract; the server is.
 *
 * The token is a CloudeIDE API token (`cide_…`), the same credential the CLI
 * uses, held in secret storage rather than settings so it never lands in a
 * synced settings file or a screenshot of one.
 */

/*
 * One name, defined where both halves can reach it.
 *
 * The agent host forwards this same secret into its spawn env so the harness
 * can run on the account's credits, and it lives in `platform` because
 * workbench may import from there and not the reverse. A second spelling here
 * would be a token that saves and never arrives.
 */
const TOKEN_KEY = CloudeideTokenSecret;

export interface ChatMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
}


/**
 * What `/ai/agent` streams back.
 *
 * Deliberately the server's own shape rather than a translation of it: the
 * panel was wired to `/ai/chat` for months on the strength of a guess about
 * what the server sent, and the guess was wrong in a way that took a filmed
 * recording to notice. These names are copied from `agentLoop.ts`.
 */
export type AgentEvent =
	| { type: 'run'; runId: string }
	| { type: 'step'; index: number; summary: string; tool: string; path?: string }
	| { type: 'step_done'; index: number; isError: boolean }
	| { type: 'text'; text: string }
	| { type: 'usage'; inputTokens: number; outputTokens: number; creditsSpent: number; steps: number }
	| { type: 'proposal'; changes: FileChange[]; runId: string }
	| { type: 'done'; status: 'completed' | 'failed' | 'cancelled' | 'limit-reached'; reason?: string }
	| { type: 'error'; message: string };

/** One file the run wants to change, with both sides of the diff. */
export interface FileChange {
	readonly path: string;
	readonly kind: 'create' | 'edit' | 'delete';
	/** Contents before the run touched it; null for a newly created file. */
	readonly before: string | null;
	/** Contents after; null for a deletion. */
	readonly after: string | null;
}

/** The environments `/deploy/run` accepts. Anything else is a 400. */
export type DeployEnvironment = 'development' | 'preview' | 'production';

/** What `GET /billing/plan` says about the account, trimmed to what a pane shows. */
export interface BillingPlan {
	readonly plan: string;
	readonly planName: string;
	readonly amount: number;
	readonly status: string;
	readonly includedCredits: number;
	readonly includedCreditsUsed: number;
	readonly includedCreditsRemaining: number;
	readonly creditsBalance: number;
	readonly expiryDate: string | null;
}

/** One API token, as the dashboard lists it. Never the token itself. */
export interface ApiToken {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly scopes: string[];
	readonly state: string;
	readonly createdAt: string;
	readonly lastUsedAt: string | null;
}

export interface UserProfile {
	readonly name: string;
	readonly email: string;
}

/** One custom domain on a project, as `GET /deploy/domains` reports it. */
export interface DeployDomain {
	readonly id: string;
	readonly hostname: string;
	readonly environment: string;
	/** verified | pending | error */
	readonly status: string;
	/** active | provisioning | … */
	readonly ssl: string;
	readonly primary: boolean;
	/** The address the platform gives every project. It cannot be removed. */
	readonly isDefault?: boolean;
}

/** The DNS record a pending domain is waiting for somebody to create. */
export interface ValidationRecord {
	readonly name: string;
	readonly type: string;
	readonly value: string;
}

export interface DomainCheck {
	readonly status: string;
	readonly validationRecord: ValidationRecord | null;
}

/** One past deployment, trimmed to what a panel row shows. */
export interface DeploymentSummary {
	readonly id: string;
	readonly environment: string;
	readonly status: string;
	readonly createdAt: string;
	readonly liveUrl?: string;
	readonly errorSummary?: string;
	readonly durationSeconds?: number;
}

/** What `/github-connect/status` reports about the account's GitHub link. */
export interface GithubStatus {
	readonly connected: boolean;
	readonly login?: string;
}

export interface GithubRepo {
	readonly fullName: string;
	readonly defaultBranch: string;
	readonly private: boolean;
}

export interface PullRequestOpened {
	readonly url: string;
	readonly number: number;
}

export interface DeployStarted {
	/** A string, not a number: the server's `deploymentId`. */
	readonly deploymentId: string;
	readonly status: string;
}

export interface DeployStatus {
	readonly id: string;
	readonly status: string;
	readonly liveUrl?: string;
	readonly errorSummary?: string;
	readonly failedPhase?: string;
}

export class CloudeideRequestError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export class CloudeideClient {

	constructor(
		private readonly secretStorageService: ISecretStorageService,
		private readonly configurationService: IConfigurationService,
	) { }

	/**
	 * cloudeide.com — the landing page, the dashboard and the API, one host.
	 *
	 * It was api.cloudeide.com, because the apex was static hosting with no
	 * /ai/chat and no /deploy/run behind it: every call from this panel would
	 * have come back as the landing page's 404. The apex is served by the
	 * application now, so the subdomain is no longer the answer to anything.
	 *
	 * api.cloudeide.com keeps working and should keep working: every copy of
	 * this editor installed before today has it compiled in, and a default is
	 * only read when nobody has set the value.
	 */
	get serverUrl(): string {
		const configured = this.configurationService.getValue<string>('cloudeide.serverUrl');
		return (configured || CloudeideDefaultServerUrl).replace(/\/+$/, '');
	}

	/**
	 * Where the dashboard is, which is now where the landing page is too.
	 *
	 * Still its own setting rather than reusing `serverUrl`: these are one host
	 * today and there is no reason they must stay one, and a self-hosted
	 * install may well split them.
	 */
	get webUrl(): string {
		const configured = this.configurationService.getValue<string>('cloudeide.webUrl');
		return (configured || CloudeideDefaultServerUrl).replace(/\/+$/, '');
	}

	/**
	 * Which environment Deploy publishes to. The server requires one; there is
	 * no sensible silent default for "where does this go live", so the setting
	 * carries it and `development` is the safe starting point.
	 */
	get environment(): DeployEnvironment {
		const configured = this.configurationService.getValue<string>('cloudeide.environment');
		return configured === 'preview' || configured === 'production' ? configured : 'development';
	}

	/**
	 * Optional. The server resolves the account's default project when this is
	 * absent, so it only matters for an account with more than one.
	 */
	get projectId(): string | undefined {
		return this.configurationService.getValue<string>('cloudeide.projectId')?.trim() || undefined;
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

	/**
	 * Turns the code the browser handed back into a stored token.
	 *
	 * The only request in this file that sends no credential, because at this
	 * point there is none: what authenticates it is `verifier`, the secret
	 * this editor generated and never put in a URL. The server checks it
	 * against the digest it was given before the browser ever signed in.
	 */
	async exchangeEditorCode(code: string, verifier: string): Promise<{ email: string; name: string }> {
		let response: Response;
		try {
			response = await fetch(`${this.serverUrl}/api/auth/editor/exchange`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code, verifier }),
			});
		} catch {
			throw new CloudeideRequestError(`Could not reach ${this.serverUrl}.`, 0);
		}

		let body: { token?: string; user?: { email?: string; name?: string }; error?: string };
		try {
			body = await response.json() as typeof body;
		} catch {
			throw new CloudeideRequestError(`Sign-in failed (${response.status}).`, response.status);
		}

		if (!response.ok || !body.token) {
			throw new CloudeideRequestError(body.error ?? `Sign-in failed (${response.status}).`, response.status);
		}

		await this.setToken(body.token);
		return { email: body.user?.email ?? '', name: body.user?.name ?? '' };
	}

	private async send(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
		const token = await this.getToken();
		if (!token) {
			throw new CloudeideRequestError('Not connected to CloudeIDE.', 401);
		}

		// Aborted rather than left hanging: a request the editor is still
		// waiting on after two minutes is one the person has given up on.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

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

		return response;
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await this.send(path, init, 120_000);
		if (response.status === 204) {
			return undefined as T;
		}
		return await response.json() as T;
	}

	/** Confirms the token works, and returns who it belongs to. */
	async whoami(): Promise<{ email: string }> {
		const body = await this.request<{ user?: { email?: string } }>('/user/profile');
		const email = body.user?.email;
		if (!email) {
			throw new CloudeideRequestError('The server did not say who this token belongs to.', 0);
		}
		return { email };
	}

	/**
	 * Asks the model, streaming.
	 *
	 * `/ai/chat` answers with server-sent events, not a JSON document: one
	 * `text` event per fragment, then `done`. `onText` is called for each, so
	 * the answer appears as it is written instead of after it is finished.
	 */
	async chat(
		messages: readonly ChatMessage[],
		onText: (chunk: string) => void,
		system?: string,
	): Promise<string> {
		const response = await this.send('/ai/chat', {
			method: 'POST',
			body: JSON.stringify({ messages, system }),
		}, 300_000);

		const body = response.body;
		if (!body) {
			throw new CloudeideRequestError('The server sent an empty reply.', 0);
		}

		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		let full = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffered += decoder.decode(value, { stream: true });

				// Events are separated by a blank line, and a chunk can split one
				// in half, so anything after the last separator stays buffered.
				const events = buffered.split('\n\n');
				buffered = events.pop() ?? '';

				for (const event of events) {
					const line = event.split('\n').find(l => l.startsWith('data:'));
					if (!line) {
						continue;
					}
					let payload: { type?: string; text?: string; message?: string };
					try {
						payload = JSON.parse(line.slice(5).trim());
					} catch {
						continue; // A frame we cannot read is not worth failing the turn over.
					}

					if (payload.type === 'text' && typeof payload.text === 'string') {
						full += payload.text;
						onText(payload.text);
					} else if (payload.type === 'error') {
						throw new CloudeideRequestError(payload.message ?? 'The request failed.', 0);
					}
					// `meta`, `thinking` and `done` need nothing from this end:
					// thinking is the model's scratch work, not its answer.
				}
			}
		} finally {
			reader.releaseLock();
		}

		return full;
	}

	/**
	 * Runs the agent, which is what `/ai/chat` never was.
	 *
	 * `/ai/chat` answers. `/ai/agent` reads files, runs tools and comes back
	 * with a set of changes for approval — the thing this product has claimed
	 * on its front page for weeks. Same account, same key, same credits; a
	 * different route.
	 *
	 * Nothing is written by this call. The run stages its changes and sends
	 * them as a `proposal`; applying them is the editor's job, and telling the
	 * server what was decided is {@link decideProposal}.
	 */
	/**
	 * One turn of the local agent, streamed.
	 *
	 * The body is Anthropic's `/v1/messages` shape and goes to our own server,
	 * which forwards it and charges the account for what came back. Ten
	 * minutes rather than two: a turn here is one step of a loop that may run
	 * several, and a model thinking through a large file is not a hung request.
	 *
	 * The caller reads the stream. This only gets it one.
	 */
	async anthropicMessages(body: unknown): Promise<Response> {
		return this.send('/anthropic/v1/messages', {
			method: 'POST',
			body: JSON.stringify(body),
		}, 600_000);
	}

	async agent(
		messages: readonly ChatMessage[],
		onEvent: (event: AgentEvent) => void,
		options: { system?: string; allowWrites?: boolean } = {},
	): Promise<void> {
		const response = await this.send('/ai/agent', {
			method: 'POST',
			body: JSON.stringify({
				messages,
				system: options.system,
				// Off unless asked. A run that edits files without being told
				// to is a worse surprise than one that refuses to.
				allowWrites: options.allowWrites === true,
			}),
		}, 600_000);

		const body = response.body;
		if (!body) {
			throw new CloudeideRequestError('The server sent an empty reply.', 0);
		}

		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffered = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffered += decoder.decode(value, { stream: true });

				// Events are separated by a blank line, and a chunk can split
				// one in half, so anything after the last separator stays.
				const frames = buffered.split('\n\n');
				buffered = frames.pop() ?? '';

				for (const frame of frames) {
					const line = frame.split('\n').find(l => l.startsWith('data:'));
					if (!line) {
						continue;
					}
					let event: AgentEvent;
					try {
						event = JSON.parse(line.slice(5).trim()) as AgentEvent;
					} catch {
						continue; // A frame we cannot read is not worth failing the run over.
					}
					if (event.type === 'error') {
						throw new CloudeideRequestError(event.message, 0);
					}
					onEvent(event);
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Tells the server what happened to a proposal.
	 *
	 * The decision outlives the connection — the person may accept after a
	 * reload, from another window — so it travels by run id rather than by
	 * being implied by the stream ending.
	 */
	async decideProposal(runId: string, decision: 'applied' | 'discarded'): Promise<void> {
		await this.request('/assistant/proposal/decision', {
			method: 'POST',
			body: JSON.stringify({ runId, decision }),
		});
	}

	async listProjects(): Promise<{ id: number; name: string }[]> {
		const body = await this.request<{ projects?: { id: number; name: string }[] }>('/deploy/projects');
		return body.projects ?? [];
	}

	/**
	 * Starts a deployment of the given files.
	 *
	 * The server takes an environment, not a project: a project is resolved
	 * from the account, and named only when the account has more than one.
	 */
	async deploy(files: { path: string; content: string }[], commitMessage?: string): Promise<DeployStarted> {
		return this.request<DeployStarted>('/deploy/run', {
			method: 'POST',
			body: JSON.stringify({
				environment: this.environment,
				files,
				trigger: 'manual',
				...(commitMessage ? { commitMessage } : {}),
			}),
		});
	}

	async deploymentStatus(deploymentId: string): Promise<DeployStatus> {
		return this.request<DeployStatus>(`/deploy/deployments/${encodeURIComponent(deploymentId)}${this.projectQuery()}`);
	}

	/**
	 * `?projectId=…`, or nothing.
	 *
	 * Every read below is scoped to a project, and the server resolves the
	 * account's own when none is named — so passing it is only necessary for
	 * an account with more than one, and passing an empty one would be worse
	 * than passing none.
	 */
	private projectQuery(extra?: Record<string, string>): string {
		const params = new URLSearchParams(extra);
		const projectId = this.projectId;
		if (projectId) {
			params.set('projectId', projectId);
		}
		const query = params.toString();
		return query ? `?${query}` : '';
	}

	async listDeployments(limit = 10): Promise<DeploymentSummary[]> {
		const body = await this.request<{ deployments?: DeploymentSummary[] }>(
			`/deploy/deployments${this.projectQuery({ limit: String(limit) })}`,
		);
		return body.deployments ?? [];
	}

	async listDomains(): Promise<DeployDomain[]> {
		const body = await this.request<{ domains?: DeployDomain[] }>(`/deploy/domains${this.projectQuery()}`);
		return body.domains ?? [];
	}

	async addDomain(hostname: string, environment: DeployEnvironment): Promise<DeployDomain> {
		return this.request<DeployDomain>(`/deploy/domains${this.projectQuery()}`, {
			method: 'POST',
			body: JSON.stringify({ hostname, environment }),
		});
	}

	/**
	 * Asks the server to look at the certificate now.
	 *
	 * A background pass already moves these along every few minutes; this is
	 * the impatient path, for somebody who has just created the DNS record and
	 * is watching.
	 */
	async verifyDomain(id: string): Promise<DomainCheck> {
		return this.request<DomainCheck>(`/deploy/domains/${encodeURIComponent(id)}/verify${this.projectQuery()}`);
	}

	async setPrimaryDomain(id: string): Promise<void> {
		await this.request(`/deploy/domains/${encodeURIComponent(id)}/primary${this.projectQuery()}`, { method: 'POST' });
	}

	async removeDomain(id: string): Promise<void> {
		await this.request(`/deploy/domains/${encodeURIComponent(id)}${this.projectQuery()}`, { method: 'DELETE' });
	}

	/**
	 * Puts the open folder where the agent's tools can read it.
	 *
	 * `/ai/agent`'s list_files, read_file and search_workspace answer from
	 * `workspaces.state`, not from this machine — the server has no way to
	 * reach a folder on somebody's laptop. Without this the agent's own tools
	 * find an empty project and it can only work from the handful of files a
	 * message carries, which is the difference between answering about one
	 * file and understanding a codebase.
	 */
	async saveWorkspace(state: Record<string, unknown>): Promise<void> {
		await this.request('/workspace', {
			method: 'PUT',
			body: JSON.stringify({ state }),
		});
	}

	async profile(): Promise<UserProfile> {
		const body = await this.request<{ user?: { name?: string; email?: string } }>('/user/profile');
		return { name: body.user?.name ?? '', email: body.user?.email ?? '' };
	}

	// ── GitHub ────────────────────────────────────────────────────────────────

	/*
	 * All of this was on the server before the editor could reach it.
	 *
	 * `/github-connect` has held connect, disconnect, the repository list,
	 * import, commit, pull-request and the commit log since the dashboard
	 * needed them. Nothing new is added here — these are four calls that let
	 * the panel ask for what was already there.
	 */
	async githubStatus(): Promise<GithubStatus> {
		return this.request<GithubStatus>('/github-connect/status');
	}

	async githubRepos(): Promise<GithubRepo[]> {
		const body = await this.request<{ repos?: GithubRepo[] }>('/github-connect/repos');
		return body.repos ?? [];
	}

	/**
	 * Opens a pull request with the files as they stand.
	 *
	 * The server makes the branch, commits onto it and opens the request, in
	 * that order, and names the branch itself. Doing it in one call rather
	 * than three is what keeps a half-finished attempt — a branch with no
	 * commit, a commit with no request — from being something this editor can
	 * produce.
	 */
	async openPullRequest(input: {
		repo: string;
		base: string;
		title: string;
		message: string;
		files: { path: string; content: string }[];
		deletedPaths?: string[];
	}): Promise<PullRequestOpened> {
		return this.request<PullRequestOpened>('/github-connect/pull-request', {
			method: 'POST',
			body: JSON.stringify(input),
		});
	}

	async githubCommit(input: {
		repo: string;
		branch: string;
		message: string;
		files: { path: string; content: string }[];
		deletedPaths?: string[];
	}): Promise<unknown> {
		return this.request('/github-connect/commit', {
			method: 'POST',
			body: JSON.stringify(input),
		});
	}

	async billingPlan(): Promise<BillingPlan> {
		return this.request<BillingPlan>('/billing/plan');
	}

	async listTokens(): Promise<ApiToken[]> {
		const body = await this.request<{ tokens?: ApiToken[] }>('/tokens');
		return body.tokens ?? [];
	}

	/**
	 * Revokes one token. There is deliberately no create here.
	 *
	 * The server refuses to mint a token for a caller holding a token — a
	 * credential that can make more credentials cannot be contained by
	 * revoking it — and this editor authenticates with exactly that. So the
	 * pane can list and revoke, and creating stays where a browser session
	 * is.
	 */
	async revokeToken(id: string): Promise<void> {
		await this.request(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
	}
}
