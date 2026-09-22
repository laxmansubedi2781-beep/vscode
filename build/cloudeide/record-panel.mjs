// Films the product doing what the landing page says it does.
//
// Not a mock and not a mockup: this starts the application people actually
// download, opens a real folder in it, signs into the real server with a real
// token, and films whatever happens. If an answer never arrives, the job fails
// rather than shipping a film of an error — which is the whole reason for
// filming instead of drawing.
//
// It used to drive the web build over HTTP, and the footage was the reason to
// stop. The web build opens no folder: there was no tree, the files were three
// untitled buffers, and the answer to "what is total in menu.js" began "I
// don't see a file named menu.js". Accurate, and the opposite of the claim the
// film was there to support. The desktop build opens a folder, so the agent
// reads a project and the frame has a project in it.
//
// One recording, four clips. Playwright writes one video per application, and
// starting the application costs a workbench load, so the session is filmed
// once and the caller cuts it at the marks printed here. Each clip is meant to
// be eight to twelve seconds: the page wants short loops, not a screencast.

import { _electron as electron } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const APP = process.env.CLOUDEIDE_BIN;
const WORKSPACE = process.env.WORKSPACE_DIR ?? '/tmp/ws';
const TOKEN = process.env.CLOUDEIDE_API_TOKEN;
const OUT = process.env.OUT_DIR ?? 'recordings';

if (!APP) {
	console.error('CLOUDEIDE_BIN is not set: it is the path to the cloudeide executable');
	process.exit(1);
}
if (!TOKEN) {
	console.error('CLOUDEIDE_API_TOKEN is not set');
	process.exit(1);
}

await mkdir(OUT, { recursive: true });

const SIZE = { width: 1440, height: 900 };

// A first run of its own, every time. A user data directory carried over from
// another run remembers a window size, an open editor and a dismissed
// walkthrough, and a film that depends on leftovers is a film that changes
// when the leftovers do.
const app = await electron.launch({
	executablePath: APP,
	args: [
		WORKSPACE,
		'--no-sandbox',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		// The folder is one this job wrote thirty seconds ago. Left on, the
		// trust dialog covers the middle of the first frame and blocks every
		// keystroke behind it.
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--disable-telemetry',
		'--disable-updates',
		'--user-data-dir', '/tmp/cloudeide-film-data',
		'--extensions-dir', '/tmp/cloudeide-film-ext',
	],
	recordVideo: { dir: OUT, size: SIZE },
	timeout: 180_000,
});

const page = await app.firstWindow({ timeout: 180_000 });
const problems = [];
page.on('pageerror', e => problems.push(String(e).slice(0, 200)));

// The window decides the frame. Electron opens at whatever size it last used
// or a default, and the page the video records is the window's content — so
// the film is 1440x900 only if the window is.
await app.evaluate(async ({ BrowserWindow }, size) => {
	const win = BrowserWindow.getAllWindows()[0];
	if (!win) { return; }
	win.setMenuBarVisibility(false);
	win.setBounds({ x: 0, y: 0, ...size });
}, SIZE).catch(err => console.log(`could not set the window size: ${String(err).slice(0, 120)}`));

const started = Date.now();
const at = () => (Date.now() - started) / 1000;
const marks = [];
// Half a second of lead-in, so a clip never opens mid-keystroke.
const mark = (name, from, to) =>
	marks.push({ name, from: Math.max(0, from - 0.5).toFixed(2), to: to.toFixed(2) });

await page.waitForSelector('.monaco-workbench', { timeout: 180_000 });
await page.waitForSelector('.cloudeide-panel', { timeout: 120_000 });

// ---- connect -------------------------------------------------------------
// Through the command palette, because the panel no longer has a token box.
// Signing in is a browser hand-off now, which is right for a person and
// impossible here — so this uses the command that exists for exactly the
// callers that have no browser to be handed to.
await page.keyboard.press('Control+Shift+KeyP');
await page.waitForSelector('.quick-input-widget input', { timeout: 30_000 });
await page.keyboard.type('CloudeIDE: Sign In with an API Token', { delay: 12 });
await page.waitForTimeout(700);
await page.keyboard.press('Enter');

await page.waitForTimeout(700);
await page.keyboard.type(TOKEN, { delay: 4 });
await page.keyboard.press('Enter');

// The command reports with a dialog either way; dismissing it is also how
// this finds out whether it worked.
const ok = page.locator('.monaco-dialog-box');
await ok.waitFor({ timeout: 60_000 });
const dialogText = await ok.innerText();
await page.locator('.monaco-dialog-box .monaco-button').first().click();
if (!/Signed in/i.test(dialogText)) {
	console.error(`sign-in failed: ${dialogText.replace(/\s+/g, ' ').slice(0, 200)}`);
	await app.close();
	process.exit(2);
}
await page.waitForSelector('textarea.cloudeide-textarea', { timeout: 60_000 });
console.log(`connected at ${at().toFixed(1)}s`);

// ---- the project ---------------------------------------------------------
// The tree, and files opened out of it by name. Quick Open rather than clicks
// on tree rows: the row for a file inside a collapsed folder does not exist to
// be clicked, and expanding the folder first is three more things that can go
// wrong in a headless session.
const openFile = async (name) => {
	await page.keyboard.press('Control+KeyP');
	await page.waitForSelector('.quick-input-widget input', { timeout: 20_000 });
	await page.keyboard.type(name, { delay: 45 });
	await page.waitForTimeout(600);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(900);
};

const clipFilesFrom = at();
// The explorer, so the film opens on the project rather than on an editor.
await page.keyboard.press('Control+Shift+KeyE');
await page.waitForTimeout(900);
for (const name of ['index.html', 'README.md', 'menu.js']) {
	await openFile(name);
}
mark('editor-files', clipFilesFrom, at());

// ---- ask -----------------------------------------------------------------
// About the file that is open, by its real path, because now there is one.
const clipAskFrom = at();
await page.locator('textarea.cloudeide-textarea').click();
await page.keyboard.type('Show the price next to each item on the menu.', { delay: 42 });
await page.waitForTimeout(500);
await page.locator('button.cloudeide-send').click();

// The reply streams, so "finished" is the text having stopped growing rather
// than any single event. Poll the last turn until it settles.
let answer = '';
let settled = 0;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
	await page.waitForTimeout(800);
	const bodies = await page.locator('.cloudeide-turn-body').allTextContents();
	const text = bodies.at(-1) ?? '';
	if (text && text === answer) {
		if (++settled >= 3 && text.length > 40) { break; }
	} else {
		settled = 0;
	}
	answer = text;
}
await page.waitForTimeout(1200);
// Capped: the answer can run for half a minute and the page wants a loop.
mark('panel-ask', clipAskFrom, Math.min(at(), clipAskFrom + 13));

// ---- the whole surface, slowly -------------------------------------------
// A quiet pan with everything open: three tabs, the tree, the answer sitting
// in the panel. This is the shot that has to carry the top of the page.
const clipWideFrom = at();
await page.locator('.cloudeide-transcript').hover().catch(() => {});
await page.waitForTimeout(1500);
await page.mouse.wheel(0, 240);
await page.waitForTimeout(1500);
await page.keyboard.press('Control+PageDown');
await page.waitForTimeout(1800);
await page.keyboard.press('Control+PageDown');
await page.waitForTimeout(2200);
mark('editor-wide', clipWideFrom, at());

// ---- ship it -------------------------------------------------------------
// The clip the landing page has never had: the Cloud pane, Deploy pressed,
// and the address that comes back. This is the part no other editor of this
// kind can film, and filming it is the only way to know it works. It needs a
// folder, which is the other half of why this moved off the web build —
// Deploy sends the folder you are working in, and there was none to send.
const clipShipFrom = at();
let liveUrl = '';
try {
	// The Cloud pane sits under the chat, collapsed. Its header is the handle.
	await page.locator('.pane-header', { hasText: 'Cloud' }).first().click({ timeout: 20_000 });
	await page.waitForSelector('.cloudeide-cloud-deploy', { timeout: 30_000 });
	await page.waitForTimeout(1200);
	await page.locator('.cloudeide-cloud-deploy').click();

	// A build takes minutes. Poll the status line until it stops saying
	// "Building" — an address is a link, which is how a finished one reads.
	const shipDeadline = Date.now() + 10 * 60_000;
	while (Date.now() < shipDeadline) {
		await page.waitForTimeout(3000);
		const link = page.locator('.cloudeide-cloud-deploy-status a.cloudeide-cloud-link');
		if (await link.count() > 0) {
			liveUrl = (await link.first().innerText()).trim();
			break;
		}
		const status = await page.locator('.cloudeide-cloud-deploy-status').innerText().catch(() => '');
		if (status && !/Building|Reading|…/i.test(status)) {
			console.log(`deploy stopped: ${status.slice(0, 160)}`);
			break;
		}
	}
	await page.waitForTimeout(2000);
	/*
	 * The last twelve seconds, not the first.
	 *
	 * A build takes minutes and almost all of them are a spinner. The part
	 * worth looping is the end — the status line turning into an address —
	 * so the mark is measured back from now rather than forward from the
	 * click. `clipShipFrom` still bounds it, so a deploy that finished in
	 * four seconds gives a four-second clip rather than eight seconds of
	 * whatever came before it.
	 */
	mark('cloud-ship', Math.max(clipShipFrom, at() - 12), at());
	console.log(`live url: ${liveUrl || '(none)'}`);
} catch (err) {
	// A deploy that cannot run must not cost the three clips that already did.
	console.log(`deploy clip skipped: ${String(err).slice(0, 160)}`);
}

/*
 * Where to cut the bottom off, measured rather than assumed.
 *
 * The panel signs off with "Connected as <the account's email address>", and
 * that is not something to put on a public page. The cut used to be a number
 * written down when the film was 1440x900 of web build; a desktop window is
 * laid out differently, and a number that is wrong by twenty pixels either
 * publishes the address or eats the composer. So the page is asked where the
 * line actually is, and the caller crops above it. Even, because the encoders
 * want even dimensions.
 */
const cropHeight = await page.evaluate(() => {
	const el = document.querySelector('.cloudeide-status');
	if (!el) { return 0; }
	const top = Math.floor(el.getBoundingClientRect().top);
	return top > 200 ? top - (top % 2) : 0;
}).catch(() => 0);

const failed = await page.locator('.cloudeide-turn-failed').count();
console.log(`answer length: ${answer.length} characters`);
console.log(`failed turns: ${failed}`);
console.log(`page errors: ${JSON.stringify(problems.slice(0, 3))}`);
console.log(`LIVE_URL=${liveUrl}`);
console.log(`CROP_HEIGHT=${cropHeight}`);
for (const m of marks) {
	console.log(`MARK ${m.name} ${m.from} ${m.to}`);
}

const video = page.video();
await app.close();
console.log('VIDEO=' + (video ? await video.path() : ''));

if (failed > 0 || answer.length < 40) {
	console.error('the panel did not produce an answer worth filming');
	process.exit(2);
}
