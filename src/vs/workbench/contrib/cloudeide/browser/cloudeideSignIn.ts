/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { CloudeideClient } from './cloudeideClient.js';

const $ = DOM.$;

/**
 * The first thing a new install sees.
 *
 * Until now it saw the editor, and the account lived three steps away: open
 * a browser, find the dashboard, make an API token, copy it, come back, paste
 * it into a panel. Every other editor of this kind asks once, at the door,
 * and never mentions a token again. The comparison that was put to me was
 * Cursor, and it is a fair one — this is the step it does not have.
 *
 * Two ways in, and the second exists because the first is not finished.
 *
 * The browser hand-off is the one that should win: the button opens the
 * dashboard, the person signs in with whatever they already use there, and
 * the server sends them back to `cloudeide://auth?token=…`, which this picks
 * up and stores. That last hop needs a route on the server that does not
 * exist yet, so until it does the same screen also takes a pasted token —
 * the old flow, in one place instead of three, and it disappears on its own
 * the day the redirect works.
 */
export class CloudeideSignInContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideSignIn';

	private overlay: HTMLElement | undefined;
	private readonly overlayStore = this._register(new DisposableStore());
	private readonly client: CloudeideClient;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IURLService urlService: IURLService,
	) {
		super();

		this.client = new CloudeideClient(this.secretStorageService, configurationService);

		// Registered whether or not the screen is showing: the person may sign
		// in from the panel, or come back to a window that is already open.
		this._register(urlService.registerHandler({
			handleURL: async (uri: URI) => {
				if (uri.authority !== 'auth') {
					return false;
				}
				const token = new URLSearchParams(uri.query).get('token');
				if (!token) {
					return false;
				}
				await this.client.setToken(token);
				this.dismiss();
				return true;
			},
		}));

		void this.showIfSignedOut();
	}

	private async showIfSignedOut(): Promise<void> {
		const token = await this.client.getToken();
		if (token) {
			return;
		}
		this.show();
	}

	private show(): void {
		if (this.overlay) {
			return;
		}

		const container = this.layoutService.activeContainer;
		const overlay = DOM.append(container, $('.cloudeide-signin'));
		this.overlay = overlay;

		const box = DOM.append(overlay, $('.cloudeide-signin-box'));

		const title = DOM.append(box, $('h1.cloudeide-signin-title'));
		title.textContent = localize('cloudeide.signIn.title', "Sign in to CloudeIDE");

		const sub = DOM.append(box, $('p.cloudeide-signin-sub'));
		sub.textContent = localize('cloudeide.signIn.sub', "So the agent can answer about your code, and your work can go live.");

		const primary = DOM.append(box, $('button.cloudeide-button-primary.cloudeide-signin-primary')) as HTMLButtonElement;
		primary.textContent = localize('cloudeide.signIn.browser', "Sign in with your browser");
		this.overlayStore.add(DOM.addDisposableListener(primary, 'click', () => {
			this.openerService.open(URI.parse(`${this.client.serverUrl}/app/settings`));
		}));

		// The fallback, and named as one.
		const or = DOM.append(box, $('p.cloudeide-signin-or'));
		or.textContent = localize('cloudeide.signIn.or', "Or paste an API token");

		const field = DOM.append(box, $('.cloudeide-field'));
		const input = DOM.append(field, $('input.cloudeide-input')) as HTMLInputElement;
		input.type = 'password';
		input.placeholder = 'cide_live_…';
		input.setAttribute('aria-label', localize('cloudeide.signIn.tokenLabel', "CloudeIDE API token"));

		const connect = DOM.append(field, $('button.cloudeide-button-primary')) as HTMLButtonElement;
		connect.textContent = localize('cloudeide.signIn.connect', "Connect");

		const error = DOM.append(box, $('p.cloudeide-error.cloudeide-signin-error'));
		error.style.display = 'none';

		const submit = async () => {
			const value = input.value.trim();
			if (!value) {
				return;
			}
			connect.disabled = true;
			connect.textContent = localize('cloudeide.signIn.connecting', "Connecting…");
			try {
				await this.client.setToken(value);
				// Proved rather than assumed: a token that is merely stored
				// fails later, in the middle of a question, where it reads as
				// the product being broken.
				await this.client.whoami();
				this.dismiss();
			} catch (err) {
				await this.client.clearToken();
				error.textContent = err instanceof Error ? err.message : String(err);
				error.style.display = '';
				connect.disabled = false;
				connect.textContent = localize('cloudeide.signIn.connect', "Connect");
			}
		};

		this.overlayStore.add(DOM.addDisposableListener(connect, 'click', () => void submit()));
		this.overlayStore.add(DOM.addDisposableListener(input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void submit();
			}
		}));

		// A way past it. The editor is worth something without an account, and
		// a door with no handle is a worse first impression than a token box.
		const skip = DOM.append(box, $('button.cloudeide-signin-skip')) as HTMLButtonElement;
		skip.textContent = localize('cloudeide.signIn.skip', "Continue without signing in");
		this.overlayStore.add(DOM.addDisposableListener(skip, 'click', () => this.dismiss()));

		input.focus();
	}

	private dismiss(): void {
		this.overlayStore.clear();
		this.overlay?.remove();
		this.overlay = undefined;
	}
}
