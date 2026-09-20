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

/** The three ways in, in the order they are offered. */
const PROVIDERS = [
	{ id: 'google', label: localize('cloudeide.signIn.google', "Continue with Google") },
	{ id: 'github', label: localize('cloudeide.signIn.github', "Continue with GitHub") },
	{ id: 'email', label: localize('cloudeide.signIn.email', "Continue with Email") },
] as const;

/** base64url of random bytes — the verifier, and nothing else, proves who asked. */
function randomUrlSafe(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);
	return toBase64Url(buffer);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return toBase64Url(new Uint8Array(digest));
}

/**
 * The first thing a new install sees.
 *
 * Until now it saw the editor, and the account lived three steps away: open a
 * browser, find the dashboard, make an API token, copy it, come back, paste it
 * into a panel. Every other editor of this kind asks once, at the door, and
 * never mentions a token again.
 *
 * ## How a button here becomes a session
 *
 * This window picks a random `verifier` and sends only its SHA-256 to the
 * browser, in the URL it opens. The person signs in on cloudeide.com with
 * whatever they already use — the three buttons here are the three buttons
 * there — and the site hands back a one-time code through
 * `cloudeide://auth?code=…`. This window then trades that code plus the
 * verifier for a real token, over HTTPS, and stores it.
 *
 * The split matters. The redirect is the one hop outside the browser's
 * control: a custom-protocol URL passes through the desktop's handler
 * registry and usually arrives as a command-line argument, readable by other
 * processes. So nothing spendable travels there. That is PKCE, and it is why
 * the code alone is worth nothing to whoever reads it.
 */
export class CloudeideSignInContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cloudeideSignIn';

	private overlay: HTMLElement | undefined;
	private readonly overlayStore = this._register(new DisposableStore());
	private readonly client: CloudeideClient;

	/**
	 * The secret behind the challenge currently out in a browser.
	 *
	 * Kept in memory only. A verifier that outlived the window it belongs to
	 * would be a stored credential in all but name, and this one is worth
	 * nothing the moment the window closes — the person simply signs in again.
	 */
	private verifier: string | undefined;

	/* Held rather than looked up. The screen is small and built in one place;
	   re-finding its parts by selector later is how a rename becomes a silent
	   no-op instead of a compile error. */
	private box: HTMLElement | undefined;
	private errorEl: HTMLElement | undefined;
	private waitingEl: HTMLElement | undefined;
	private providerButtons: HTMLButtonElement[] = [];

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IURLService urlService: IURLService,
	) {
		super();

		this.client = new CloudeideClient(this.secretStorageService, configurationService);

		// Registered whether or not the screen is showing: the person may
		// start this from the panel, or come back to a window already open.
		this._register(urlService.registerHandler({
			handleURL: async (uri: URI) => {
				if (uri.authority !== 'auth') {
					return false;
				}
				const code = new URLSearchParams(uri.query).get('code');
				if (!code) {
					return false;
				}
				await this.completeSignIn(code);
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

	/**
	 * Spends the code the browser sent back.
	 *
	 * A code arriving without a verifier means this window did not start the
	 * flow — a second window, a restart, or a link somebody else produced.
	 * Refused rather than attempted: the exchange would fail at the server
	 * anyway, and failing here says something truer about why.
	 */
	private async completeSignIn(code: string): Promise<void> {
		if (!this.verifier) {
			this.fail(localize('cloudeide.signIn.noVerifier',
				"This window did not start that sign-in. Press one of the buttons above and try again."));
			return;
		}

		const verifier = this.verifier;
		// Single use here as well as on the server: a verifier that can be
		// replayed is one an interrupted flow leaves lying around.
		this.verifier = undefined;

		try {
			await this.client.exchangeEditorCode(code, verifier);
			this.dismiss();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : String(err));
		}
	}

	private fail(message: string): void {
		if (this.errorEl) {
			this.errorEl.textContent = message;
			this.errorEl.style.display = '';
		}
		this.waitingEl?.remove();
		this.waitingEl = undefined;
		for (const button of this.providerButtons) {
			button.disabled = false;
		}
	}

	private show(): void {
		if (this.overlay) {
			return;
		}

		const container = this.layoutService.activeContainer;
		const overlay = DOM.append(container, $('.cloudeide-signin'));
		this.overlay = overlay;

		const box = DOM.append(overlay, $('.cloudeide-signin-box'));
		this.box = box;

		const title = DOM.append(box, $('h1.cloudeide-signin-title'));
		title.textContent = localize('cloudeide.signIn.title', "Sign in to CloudeIDE");

		const sub = DOM.append(box, $('p.cloudeide-signin-sub'));
		sub.textContent = localize('cloudeide.signIn.sub', "So the agent can answer about your code, and your work can go live.");

		const choices = DOM.append(box, $('.cloudeide-signin-choices'));
		for (const provider of PROVIDERS) {
			const button = DOM.append(choices, $('button.cloudeide-signin-provider')) as HTMLButtonElement;
			button.textContent = provider.label;
			this.providerButtons.push(button);
			this.overlayStore.add(DOM.addDisposableListener(button, 'click', () => {
				void this.startSignIn(provider.id, button);
			}));
		}

		const error = DOM.append(box, $('p.cloudeide-error.cloudeide-signin-error'));
		error.style.display = 'none';
		this.errorEl = error;

		// A way past it. The editor is worth something without an account, and
		// a door with no handle is a worse first impression than one button
		// too many.
		const skip = DOM.append(box, $('button.cloudeide-signin-skip')) as HTMLButtonElement;
		skip.textContent = localize('cloudeide.signIn.skip', "Continue without signing in");
		this.overlayStore.add(DOM.addDisposableListener(skip, 'click', () => this.dismiss()));
	}

	private async startSignIn(provider: string, button: HTMLButtonElement): Promise<void> {
		if (this.errorEl) {
			this.errorEl.style.display = 'none';
		}

		const verifier = randomUrlSafe(32);
		let challenge: string;
		try {
			challenge = await sha256Base64Url(verifier);
		} catch {
			this.fail(localize('cloudeide.signIn.noCrypto',
				"This window cannot generate a sign-in code. Restart CloudeIDE and try again."));
			return;
		}
		this.verifier = verifier;

		const url = URI.parse(`${this.client.webUrl}/app/editor-auth`).with({
			query: new URLSearchParams({
				challenge,
				provider,
				label: localize('cloudeide.signIn.tokenName', "CloudeIDE desktop"),
			}).toString(),
		});
		this.openerService.open(url, { openExternal: true });

		button.disabled = true;
		if (this.waitingEl || !this.box) {
			return;
		}
		this.waitingEl = DOM.append(this.box, $('p.cloudeide-signin-waiting'));
		this.waitingEl.textContent = localize('cloudeide.signIn.waiting',
			"Finish signing in in your browser. This window will pick it up.");
	}

	private dismiss(): void {
		this.overlayStore.clear();
		this.overlay?.remove();
		this.overlay = undefined;
		this.box = undefined;
		this.errorEl = undefined;
		this.waitingEl = undefined;
		this.providerButtons = [];
	}
}
