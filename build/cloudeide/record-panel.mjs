// Films the product doing what the landing page says it does.
//
// Not a mock and not a mockup: this drives the real web build against the
// real server with a real token, and films whatever happens. If an answer
// never arrives, the job fails rather than shipping a film of an error —
// which is the whole reason for filming instead of drawing.
//
// One recording, three clips. Playwright writes one video per context, and a
// context costs a full workbench load, so the session is filmed once and the
// caller cuts it at the marks printed here. Each clip is meant to be eight to
// twelve seconds: the page wants three short loops, not a screencast.
//
// The token reaches the page through a password field, so it renders as dots,
// and no mark begins before the connection is made.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const URL_BASE = process.env.EDITOR_URL ?? 'http://127.0.0.1:8099/index.html';
const TOKEN = process.env.CLOUDEIDE_API_TOKEN;
const OUT = process.env.OUT_DIR ?? 'recordings';
const CHROME = process.env.CHROME_PATH;

if (!TOKEN) {
	console.error('CLOUDEIDE_API_TOKEN is not set');
	process.exit(1);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
	...(CHROME ? { executablePath: CHROME } : {}),
	args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
});

const started = Date.now();
const at = () => (Date.now() - started) / 1000;
const marks = [];
// Half a second of lead-in, so a clip never opens mid-keystroke.
const mark = (name, from, to) =>
	marks.push({ name, from: Math.max(0, from - 0.5).toFixed(2), to: to.toFixed(2) });

const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(String(e).slice(0, 200)));

await page.goto(URL_BASE, { waitUntil: 'load', timeout: 120_000 });
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
	process.exit(2);
}
await page.waitForSelector('textarea.cloudeide-textarea', { timeout: 60_000 });
console.log(`connected at ${at().toFixed(1)}s`);

// ---- clear the stage -----------------------------------------------------
// The walkthrough opens on a new profile and fills two thirds of the frame
// with a theme picker whose thumbnails do not load — four broken-image icons
// in the middle of the shot. Nothing about it is the product.
await page.keyboard.press('Control+KeyK');
await page.waitForTimeout(400);
await page.keyboard.press('Control+KeyW');
await page.waitForTimeout(1200);

// ---- files to work in ----------------------------------------------------
// Flat statements, no braces: the editor's auto-indent has mangled typed
// samples before, and it only does that when a line opens a block.
const files = [
	['menu.js', 'const price = 120;\nconst tax = 0.13;\nconst total = price * (1 + tax);\n'],
	['cart.js', 'const items = 3;\nconst shipping = 40;\n'],
	['app.js', 'const currency = "NPR";\nconst open = true;\n'],
];

const clipFilesFrom = at();
for (const [, body] of files) {
	await page.keyboard.press('Control+KeyN');
	await page.waitForTimeout(700);
	await page.keyboard.type(body, { delay: 40 });
	await page.waitForTimeout(500);
}
// Move across the tabs, which is the shot: several files open at once.
for (let i = 0; i < 3; i++) {
	await page.keyboard.press('Control+PageUp');
	await page.waitForTimeout(900);
}
mark('editor-files', clipFilesFrom, at());

// ---- ask -----------------------------------------------------------------
const clipAskFrom = at();
await page.locator('textarea.cloudeide-textarea').click();
await page.keyboard.type('What is total in menu.js, and what would you add?', { delay: 42 });
await page.waitForTimeout(500);
await page.locator('button.cloudeide-send').click();

// The reply streams, so "finished" is the text having stopped growing rather
// than any single event. Poll the last turn until it settles.
let answer = '';
let settled = 0;
const deadline = Date.now() + 120_000;
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
// kind can film, and filming it is the only way to know it works.
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
	// A deploy that cannot run must not cost the two clips that already did.
	console.log(`deploy clip skipped: ${String(err).slice(0, 160)}`);
}

const failed = await page.locator('.cloudeide-turn-failed').count();
console.log(`answer length: ${answer.length} characters`);
console.log(`failed turns: ${failed}`);
console.log(`page errors: ${JSON.stringify(problems.slice(0, 3))}`);
console.log(`LIVE_URL=${liveUrl}`);
for (const m of marks) {
	console.log(`MARK ${m.name} ${m.from} ${m.to}`);
}

const video = page.video();
await context.close();
await browser.close();
console.log('VIDEO=' + (video ? await video.path() : ''));

if (failed > 0 || answer.length < 40) {
	console.error('the panel did not produce an answer worth filming');
	process.exit(2);
}
