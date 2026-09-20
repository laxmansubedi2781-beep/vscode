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
const tokenField = page.locator('input.cloudeide-input');
await tokenField.waitFor({ timeout: 30_000 });
await tokenField.fill(TOKEN);
await page.locator('.cloudeide-connect button.cloudeide-button-primary').click();
await page.waitForSelector('textarea.cloudeide-textarea', { timeout: 60_000 });
console.log(`connected at ${at().toFixed(1)}s`);

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

const failed = await page.locator('.cloudeide-turn-failed').count();
console.log(`answer length: ${answer.length} characters`);
console.log(`failed turns: ${failed}`);
console.log(`page errors: ${JSON.stringify(problems.slice(0, 3))}`);
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
