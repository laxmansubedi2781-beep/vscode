/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the agent has done in this folder, across windows.
 *
 * Today the transcript is the history, and it lives for exactly as long as
 * the window does. Close the editor, come back tomorrow, and there is no
 * record that an agent ever touched anything — not what was asked, not which
 * files it changed, not whether the change was kept. Git knows, eventually,
 * if somebody committed. Nothing else does.
 *
 * So each finished run is written down: what was asked, when, which files
 * changed and by how much, and what happened to them. Ten of them, per
 * folder.
 *
 * Not the conversation. Keeping every message would mean keeping whatever
 * the person pasted into it — a stack trace with a path in it, a config file
 * with a key in it — in workspace storage, forever, for a feature nobody
 * asked for. The ask and the file list are what somebody actually looks
 * back at, and they are the harmless part.
 *
 * VS Code has a session list of its own, under chat. It is fed by
 * `IChatSessionsService` providers and is built for several agents running
 * at once in the background, which is not the shape of this panel — one
 * agent, in front of you. Using it would have meant registering our runs as
 * chat sessions, which is the coupling this panel exists to avoid.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const KEY = 'cloudeide.runHistory';

/** How many runs are kept. Past this the oldest goes. */
const KEPT = 10;

/** How much of the ask is kept, so one paste cannot fill the store. */
const MAX_ASK = 400;

export interface HistoryFile {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
}

export interface HistoryRun {
	readonly id: string;
	/** What the person asked, trimmed. */
	readonly ask: string;
	/** When the run finished, as an ISO string. */
	readonly at: string;
	readonly files: readonly HistoryFile[];
	/** kept | undone | pending — what became of the change. */
	readonly outcome: 'kept' | 'undone' | 'pending';
}

export class CloudeideHistory extends Disposable {

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
	}

	/**
	 * Everything remembered, newest first.
	 *
	 * Anything unreadable is treated as nothing rather than thrown: a
	 * history that cannot be parsed is not worth failing a panel over, and
	 * the next write replaces it.
	 */
	read(): HistoryRun[] {
		const raw = this.storageService.get(KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter(isRun) : [];
		} catch {
			return [];
		}
	}

	add(run: HistoryRun): void {
		const trimmed: HistoryRun = { ...run, ask: run.ask.slice(0, MAX_ASK) };
		this.write([trimmed, ...this.read().filter(r => r.id !== run.id)].slice(0, KEPT));
	}

	/** Records what became of a run's change, once somebody has decided. */
	settle(id: string, outcome: HistoryRun['outcome']): void {
		const runs = this.read();
		const found = runs.findIndex(r => r.id === id);
		if (found === -1) {
			return;
		}
		runs[found] = { ...runs[found], outcome };
		this.write(runs);
	}

	clear(): void {
		this.storageService.remove(KEY, StorageScope.WORKSPACE);
	}

	private write(runs: readonly HistoryRun[]): void {
		/*
		 * MACHINE, not USER.
		 *
		 * This is a note about what happened on this computer, in this
		 * folder. Syncing it to somebody's other machines would carry a list
		 * of their file paths to a place they never asked it to go, and it
		 * would be wrong there anyway — the runs did not happen on that
		 * machine.
		 */
		this.storageService.store(KEY, JSON.stringify(runs), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

function isRun(value: unknown): value is HistoryRun {
	const run = value as HistoryRun | undefined;
	return !!run
		&& typeof run.id === 'string'
		&& typeof run.ask === 'string'
		&& typeof run.at === 'string'
		&& Array.isArray(run.files);
}

/** Where a remembered file is now, so a row can open it. */
export function historyFileUri(root: URI, path: string): URI {
	return root.with({ path: `${root.path.replace(/\/+$/, '')}/${path}` });
}
