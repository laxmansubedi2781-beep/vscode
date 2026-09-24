/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CloudeIDE. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ExtensionGalleryManifestService } from '../../../../../platform/extensionManagement/common/extensionGalleryManifestService.js';
import { ExtensionGalleryResourceType, getExtensionGalleryManifestResourceUri, IExtensionGalleryManifest } from '../../../../../platform/extensionManagement/common/extensionGalleryManifest.js';

/**
 * The Extensions view reads its store from product.json.
 *
 * With no `extensionsGallery` the view has nothing to search and says so, and
 * that is how this fork shipped: an editor nobody could add Python support
 * to. The store is Open VSX, and two things are worth holding down — that the
 * product points there, and that the editor does not go looking for newest
 * versions at a path only Microsoft's marketplace answers, because Open VSX
 * answering that path with 404 reads as "not in the store" and no update is
 * ever found.
 *
 * The product.json side of this — that the file really names Open VSX — is
 * checked by build/cloudeide/test/run.mjs before these run, because source
 * under src/vs may not import the file. `OPEN_VSX` here is the same block, and
 * the runner fails if the two drift apart.
 */
export const OPEN_VSX = {
	serviceUrl: 'https://open-vsx.org/vscode/gallery',
	itemUrl: 'https://open-vsx.org/vscode/item',
	publisherUrl: 'https://open-vsx.org/namespace',
	resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
	extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
	controlUrl: 'https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json',
	nlsBaseUrl: '',
};

async function manifestFor(gallery: object | undefined): Promise<IExtensionGalleryManifest | null> {
	const productService = { _serviceBrand: undefined, extensionsGallery: gallery } as unknown as IProductService;
	const service = new ExtensionGalleryManifestService(productService);
	try {
		return await service.getExtensionGalleryManifest();
	} finally {
		service.dispose();
	}
}

suite('CloudeIDE extension store', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('search goes to the Open VSX query endpoint', async () => {
		const manifest = await manifestFor(OPEN_VSX);
		assert.ok(manifest);
		assert.strictEqual(
			getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionQueryService),
			'https://open-vsx.org/vscode/gallery/extensionquery');
	});

	test('downloads and details come from Open VSX', async () => {
		const manifest = await manifestFor(OPEN_VSX);
		assert.ok(manifest);
		const resource = getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionResourceUri);
		assert.ok(resource?.startsWith('https://open-vsx.org/vscode/unpkg/'), resource);
		const details = getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionDetailsViewUri);
		assert.ok(details?.startsWith('https://open-vsx.org/vscode/item'), details);
	});

	test('no latest-version path is guessed, so updates go through the query', async () => {
		const manifest = await manifestFor(OPEN_VSX);
		assert.ok(manifest);
		assert.strictEqual(
			getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionLatestVersionUri),
			undefined);
	});

	test('a latest-version path is used when the product names one', async () => {
		const manifest = await manifestFor({ ...OPEN_VSX, latestUrlTemplate: 'https://example.test/{publisher}/{name}/latest' });
		assert.ok(manifest);
		assert.strictEqual(
			getExtensionGalleryManifestResourceUri(manifest, ExtensionGalleryResourceType.ExtensionLatestVersionUri),
			'https://example.test/{publisher}/{name}/latest');
	});

	test('with no store configured there is no manifest, as before', async () => {
		assert.strictEqual(await manifestFor(undefined), null);
	});
});
