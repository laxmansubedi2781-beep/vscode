// Turns the packaged vscode-web build into a directory a plain static host can
// serve — no Node server, no remote.
//
// The packaged build carries the workbench bundle but no page to load it: it is
// meant to be embedded, and the embedder supplies the page that calls
// `create()`. Upstream's own server writes that page per request, filling in
// values it knows at request time. This writes the same page once, with those
// values fixed.
//
// Usage: make-static.mjs <vscode-web build dir> <output dir> [repo root]

import { readFile, writeFile, cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [, , SRC, OUT, REPO = path.join(SRC, '..', 'vscode')] = process.argv;
if (!SRC || !OUT) {
	console.error('usage: make-static.mjs <vscode-web build dir> <output dir> [repo root]');
	process.exit(1);
}

// @vscode/test-web already ships the bootstrap this page needs — a
// WorkspaceProvider that reads ?folder= from the URL, and a localStorage-backed
// URL callback. Reusing it beats writing a second one to drift out of step.
const TEST_WEB = path.join(REPO, 'node_modules', '@vscode', 'test-web');

const html = await readFile(path.join(TEST_WEB, 'views', 'workbench-esm.html'), 'utf8');
const bootstrap = (await readFile(path.join(TEST_WEB, 'out', 'browser', 'esm', 'main.js'), 'utf8'))
	.replace('./workbench.api', './out/vs/workbench/workbench.web.main.internal.js');

const config = {
	// No remote: the workbench runs entirely in the tab, on the web worker
	// extension host. An authority here would have it dial a server that does
	// not exist.
	_wrapWebWorkerExtHostInIframe: false,
	developmentOptions: {},
	enableWorkspaceTrust: true,
	productConfiguration: { embedderIdentifier: 'cloudeide-static' },
	callbackRoute: '/callback.html',
};

const asAttr = (value) => JSON.stringify(value).replace(/"/g, '&quot;');

const values = {
	WORKBENCH_WEB_CONFIGURATION: asAttr(config),
	// The built bundle carries its own list of built-in extensions, baked in at
	// build time, so this element is only read when running from sources.
	WORKBENCH_BUILTIN_EXTENSIONS: asAttr([]),
	WORKBENCH_WEB_BASE_URL: '.',
	WORKBENCH_MAIN: [
		'<script src="./out/nls.messages.js"></script>',
		`<script type="module">${bootstrap}</script>`,
	].join('\n'),
};

// The packaged build puts the PWA icons at its root; the template expects them
// under out/. Point at where they actually are.
const page = html
	.replace(/\{\{([^}]+)\}\}/g, (_, key) => values[key] ?? '')
	.replace(/\.\/out\/code-/g, './code-');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'index.html'), page);

// Tells GitHub Pages to serve the directory as-is. Without it Jekyll runs and
// drops every path beginning with an underscore.
await writeFile(path.join(OUT, '.nojekyll'), '');

for (const entry of ['out', 'extensions', 'node_modules', 'favicon.ico', 'manifest.json', 'code-192.png', 'code-512.png']) {
	const from = path.join(SRC, entry);
	if (existsSync(from)) {
		await cp(from, path.join(OUT, entry), { recursive: true });
	}
}

// Mermaid diagram previews and the separate "sessions" surface: ~80MB the
// preview never loads. Dropped so the upload stays a sane size.
for (const fat of ['extensions/mermaid-markdown-features', 'out/vs/sessions']) {
	await rm(path.join(OUT, fat), { recursive: true, force: true });
}

console.log('wrote', OUT);
