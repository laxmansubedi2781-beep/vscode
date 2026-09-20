/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
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
 * Google's mark, drawn rather than fetched.
 *
 * Four fixed brand colours, which is the one place in this panel that does not
 * come from a theme token: a Google button that is grey in a light theme and
 * white in a dark one is not their mark any more, and a person scanning three
 * buttons finds this one by its colour before they read the word.
 */
function googleMark(): SVGElement {
	const svg = $.SVG<SVGElement>('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true', focusable: 'false' });
	const paths: readonly (readonly [string, string])[] = [
		['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
		['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
		['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
		['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z'],
	];
	for (const [fill, d] of paths) {
		// appendChild rather than DOM.append: that helper takes an HTMLElement
		// parent, and this one is an SVGElement.
		svg.appendChild($.SVG('path', { fill, d }));
	}
	return svg;
}

/** GitHub and the envelope are in the icon font already, and follow the theme. */
function codiconMark(icon: ThemeIcon): HTMLElement {
	return $(`span${ThemeIcon.asCSSSelector(icon)}`);
}

/** The three ways in, in the order they are offered. */
const PROVIDERS = [
	{ id: 'google', label: localize('cloudeide.signIn.google', "Google"), mark: googleMark },
	{ id: 'github', label: localize('cloudeide.signIn.github', "GitHub"), mark: () => codiconMark(Codicon.githubInverted) },
	{ id: 'email', label: localize('cloudeide.signIn.email', "Email"), mark: () => codiconMark(Codicon.mail) },
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

	/** SHA-256 of {@link verifier}, computed up front — see `prepareChallenge`. */
	private challenge: string | undefined;

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
		// replayed is one an interrupted flow leaves lying around. A fresh pair
		// is prepared straight away, because the screen is still open and the
		// person may well press another button.
		this.verifier = undefined;
		this.challenge = undefined;
		void this.prepareChallenge();

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
			DOM.append(button, provider.mark());
			DOM.append(button, $('span.cloudeide-signin-provider-label')).textContent = provider.label;
			this.providerButtons.push(button);
			this.overlayStore.add(DOM.addDisposableListener(button, 'click', () => {
				this.startSignIn(provider.id, button);
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

		// Ready before the first button can be pressed, so pressing one opens a
		// browser in the same tick.
		void this.prepareChallenge();
	}

	/**
	 * Picks the secret and hashes it, before anybody presses anything.
	 *
	 * This has to happen ahead of the click rather than inside it. Hashing is
	 * async — `crypto.subtle` returns a promise — and a browser only lets a
	 * page open a window while it still counts the action as the person's. An
	 * `await` in between spends that, and the browser blocks the window
	 * silently: the button appears dead, which is exactly how it looked.
	 *
	 * So the click handler below is synchronous all the way to `open`.
	 */
	private async prepareChallenge(): Promise<void> {
		const verifier = randomUrlSafe(32);
		try {
			this.challenge = await sha256Base64Url(verifier);
			this.verifier = verifier;
		} catch {
			this.fail(localize('cloudeide.signIn.noCrypto',
				"This window cannot generate a sign-in code. Restart CloudeIDE and try again."));
		}
	}

	private startSignIn(provider: string, button: HTMLButtonElement): void {
		if (this.errorEl) {
			this.errorEl.style.display = 'none';
		}

		const challenge = this.challenge;
		if (!challenge) {
			this.fail(localize('cloudeide.signIn.notReady',
				"Still getting ready. Try that again in a moment."));
			return;
		}

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
		this.verifier = undefined;
		this.challenge = undefined;
	}
}
