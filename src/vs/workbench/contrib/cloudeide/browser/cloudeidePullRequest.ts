/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Getting a run's work off this machine.
 *
 * The agent could change files and the person could keep them, and that was
 * where it stopped. Everything after — branch, commit, push, open a request,
 * paste the link to somebody — happened in a terminal or a browser, which is
 * the point where a tool stops being the place the work happens.
 *
 * None of the hard part is here. `/github-connect` has held the connection,
 * the repository list, commit, and pull-request since the dashboard needed
 * them, and the server makes the branch, commits onto it and opens the
 * request in one call — so a half-finished attempt, a branch with no commit
 * or a commit with no request, is not a thing this editor can produce. What
 * this file does is collect the files, ask, and report.
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CloudeideClient, type PullRequestOpened } from './cloudeideClient.js';
import { collectWorkspaceFiles } from './cloudeideWorkspace.js';

/** What the card needs to show before anybody presses anything. */
export interface PullRequestProposal {
	readonly repo: string;
	readonly base: string;
	readonly title: string;
	readonly message: string;
	readonly files: readonly { path: string; content: string }[];
}

export class CloudeidePullRequests extends Disposable {

	constructor(
		private readonly client: CloudeideClient,
		private readonly fileService: IFileService,
		private readonly contextService: IWorkspaceContextService,
	) {
		super();
	}

	/**
	 * Whether this account can open one at all.
	 *
	 * Asked before the card is drawn rather than after the button is pressed:
	 * "Open PR" that answers "connect GitHub first" is a button that should
	 * have said so while there was still time to do something about it.
	 */
	async connected(): Promise<{ ok: boolean; login?: string; why?: string }> {
		try {
			const status = await this.client.githubStatus();
			return status.connected
				? { ok: true, login: status.login }
				: {
					ok: false, why: localize('cloudeide.pr.notConnected',
						"GitHub is not connected to this account. Connect it in the dashboard, then try again."),
				};
		} catch (err) {
			return { ok: false, why: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Everything in the open folder, as the server wants it.
	 *
	 * The whole folder rather than only what the agent touched, because a
	 * pull request is a statement about the state of a branch, not a patch —
	 * and a branch built from four files would delete every file the person
	 * did not happen to have the agent edit.
	 */
	async collect(root: URI, token: CancellationToken): Promise<{ path: string; content: string }[]> {
		void root;
		void token;
		return collectWorkspaceFiles(this.fileService, this.contextService);
	}

	async open(proposal: PullRequestProposal): Promise<PullRequestOpened> {
		return this.client.openPullRequest({
			repo: proposal.repo,
			base: proposal.base,
			title: proposal.title,
			message: proposal.message,
			files: [...proposal.files],
		});
	}

	/** The repositories this account can push to, newest first. */
	async repos(): Promise<{ label: string; base: string }[]> {
		const repos = await this.client.githubRepos();
		return repos.map(r => ({ label: r.fullName, base: r.defaultBranch }));
	}
}

/**
 * A title and a body from what the run did.
 *
 * Not a second call to a model. The person has just read the change and the
 * agent has just described it; asking a model to summarise the summary costs
 * a turn and produces something less accurate than the sentence already on
 * screen. This takes the agent's own last reply, uses its first line as the
 * title and the rest as the body, and appends the file list — which is the
 * part a reviewer actually reads first.
 */
export function describeChange(reply: string, files: readonly string[]): { title: string; message: string } {
	const trimmed = reply.trim();
	const firstLine = trimmed.split('\n').find(line => line.trim().length > 0)?.trim() ?? '';

	// A title is one line and short. A model that answered in a paragraph
	// gets cut at a sentence boundary rather than mid-word.
	let title = firstLine.replace(/^#+\s*/, '');
	if (title.length > 72) {
		const stop = title.slice(0, 72).lastIndexOf('. ');
		title = stop > 20 ? title.slice(0, stop) : `${title.slice(0, 69)}…`;
	}
	if (!title) {
		title = localize('cloudeide.pr.fallbackTitle', "Changes from CloudeIDE");
	}

	const list = files.length > 0
		? `\n\n${localize('cloudeide.pr.filesHeading', "Files changed")}\n${files.map(f => `- ${f}`).join('\n')}`
		: '';

	return { title, message: `${trimmed || title}${list}` };
}
