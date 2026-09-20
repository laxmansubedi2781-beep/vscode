// Records the panel doing the thing the landing page claims it does.
//
// Not a mock and not a mockup: this drives the real web build against the
// real server with a real token, and films whatever happens. If the answer
// never arrives, the film shows that instead — which is the point of filming
// rather than drawing.
//
// The token reaches the page through a password field, so it renders as dots,
// and the film is trimmed to start after the connection is made. The script
// prints TRIM_START so the caller knows where the interesting part begins.

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
const since = () => ((Date.now() - started) / 1000).toFixed(1);

const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(String(e).slice(0, 200)));

await page.goto(URL_BASE, { waitUntil: 'load', timeout: 120_000 });
await page.waitForSelector('.monaco-workbench', { timeout: 180_000 });
// The workbench paints in stages and the panel is registered late; waiting for
// the panel itself is the honest signal that it is ready to be driven.
await page.waitForSelector('.cloudeide-panel', { timeout: 120_000 });

// ---- connect, off camera as far as anything readable goes ---------------
const tokenField = page.locator('input.cloudeide-input');
await tokenField.waitFor({ timeout: 30_000 });
await tokenField.fill(TOKEN);
await page.locator('.cloudeide-connect button.cloudeide-button-primary').click();
await page.waitForSelector('textarea.cloudeide-textarea', { timeout: 60_000 });
console.log(`connected at ${since()}s`);

// ---- a file to talk about ------------------------------------------------
// Two flat statements and no braces: the editor's auto-indent has mangled
// typed samples before, and it only does that when a line opens a block.
await page.keyboard.press('Control+KeyN');
await page.waitForTimeout(1500);
await page.keyboard.type('const price = 120;\n', { delay: 55 });
await page.keyboard.type('const tax = 0.13;\n', { delay: 55 });
await page.waitForTimeout(1200);

// Everything before this point is setup. The film starts here.
const trimStart = (Date.now() - started) / 1000;
console.log(`TRIM_START=${Math.max(0, trimStart - 0.6).toFixed(2)}`);

// ---- ask ------------------------------------------------------------------
const question = 'What does this file do, and what would you add to it?';
await page.locator('textarea.cloudeide-textarea').click();
await page.keyboard.type(question, { delay: 45 });
await page.waitForTimeout(600);
await page.locator('button.cloudeide-send').click();

// ---- wait for the answer, and notice if it never comes --------------------
// The reply streams, so "finished" is the text having stopped growing rather
// than any single event. Poll the last turn until it settles.
let last = '';
let settledFor = 0;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
	await page.waitForTimeout(1000);
	const bodies = await page.locator('.cloudeide-turn-body').allTextContents();
	const text = bodies.at(-1) ?? '';
	if (text && text === last) {
		settledFor += 1;
		if (settledFor >= 3 && text.length > 40) {
			break;
		}
	} else {
		settledFor = 0;
	}
	last = text;
}

const failed = await page.locator('.cloudeide-turn-failed').count();
console.log(`answer length: ${last.length} characters after ${since()}s`);
console.log(`failed turns: ${failed}`);
console.log(`page errors: ${JSON.stringify(problems.slice(0, 3))}`);

// A beat on the finished answer, so the film does not cut on the last word.
await page.waitForTimeout(2500);

const video = page.video();
await context.close();
await browser.close();
console.log('VIDEO=' + (video ? await video.path() : ''));

if (failed > 0 || last.length < 40) {
	console.error('the panel did not produce an answer worth filming');
	process.exit(2);
}
