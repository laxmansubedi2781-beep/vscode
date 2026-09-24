/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs the CloudeIDE panel's unit tests, in a browser, in about five seconds.
 *
 * The repository's own test runner builds the whole workbench first, which is
 * half an hour. These tests do not need a workbench — they need a browser,
 * because the code under test reaches DOM types through its imports even on
 * paths that never touch one, and node has no `window` to satisfy that.
 *
 * So: esbuild bundles the test files for a browser, Playwright opens a blank
 * page, mocha runs inside it, and the exit code is the number of failures.
 *
 *   node build/cloudeide/test/run.mjs
 *
 * Playwright's Chromium is expected at PLAYWRIGHT_CHROMIUM or on the default
 * path the container provides. Nothing here is wired into CI yet; it is a
 * thing to run while writing, which is when the answer is worth having.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

const TESTS = [
	'src/vs/workbench/contrib/cloudeide/test/browser/cloudeideAgentLoop.test.ts',
	'src/vs/workbench/contrib/cloudeide/test/browser/cloudeideAgentTools.test.ts',
	'src/vs/workbench/contrib/cloudeide/test/browser/cloudeideMentions.test.ts',
];

const work = mkdtempSync(path.join(tmpdir(), 'cloudeide-test-'));
const entry = path.join(work, 'entry.ts');
const bundle = path.join(work, 'tests.js');

writeFileSync(entry, TESTS.map(file => `import '${path.join(root, file).replace(/\.ts$/, '.js')}';`).join('\n'));

execFileSync('npx', [
	'esbuild', entry,
	'--bundle', '--platform=browser', '--format=iife',
	`--outfile=${bundle}`,
	`--alias:assert=${path.join(here, 'assert-shim.js')}`,
	'--log-level=warning',
], { cwd: root, stdio: 'inherit' });

const { chromium } = await import('playwright');
const browser = await chromium.launch(
	process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const page = await browser.newPage();

// mocha's own spec reporter writes through console.log with %s placeholders,
// which a browser fills in but a relayed string does not. Joining the pieces
// back together here keeps the output readable.
page.on('console', message => {
	const text = message.text();
	if (text.trim()) {
		console.log(text.replace(/%[sdc]/g, '').replace(/\s+$/, ''));
	}
});
page.on('pageerror', error => console.error('page error:', error.message));

await page.setContent('<!doctype html><html><body><div id="mocha"></div></body></html>');
await page.addScriptTag({ content: readFileSync(path.join(root, 'node_modules/mocha/mocha.js'), 'utf8') });
await page.evaluate(() => globalThis.mocha.setup({ ui: 'tdd', reporter: 'spec' }));
await page.addScriptTag({ content: readFileSync(bundle, 'utf8') });

const failures = await page.evaluate(() => new Promise(resolve => globalThis.mocha.run(resolve)));
await browser.close();

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
