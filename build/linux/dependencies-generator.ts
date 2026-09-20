/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { getChromiumSysroot, getVSCodeSysroot } from './debian/install-sysroot.ts';
import { generatePackageDeps as generatePackageDepsDebian } from './debian/calculate-deps.ts';
import { generatePackageDeps as generatePackageDepsRpm } from './rpm/calculate-deps.ts';
import { referenceGeneratedDepsByArch as debianGeneratedDeps } from './debian/dep-lists.ts';
import { referenceGeneratedDepsByArch as rpmGeneratedDeps } from './rpm/dep-lists.ts';
import { type DebianArchString, isDebianArchString } from './debian/types.ts';
import { isRpmArchString, type RpmArchString } from './rpm/types.ts';
import product from '../../product.json' with { type: 'json' };

// A flag that can easily be toggled.
// Make sure to compile the build directory after toggling the value.
// If false, we warn about new dependencies if they show up
// while running the prepare package tasks for a release.
// If true, we fail the build if there are new dependencies found during that task.
// The reference dependencies, which one has to update when the new dependencies
// are valid, are in dep-lists.ts
const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = true;

// Based on https://source.chromium.org/chromium/chromium/src/+/refs/tags/148.0.7778.280:chrome/installer/linux/BUILD.gn;l=64-80
// and the Linux Archive build
// Shared library dependencies that we already bundle.
const bundledDeps = [
	'libEGL.so',
	'libGLESv2.so',
	'libvulkan.so.1',
	'libvk_swiftshader.so',
	'libffmpeg.so',
];

export async function getDependencies(packageType: 'deb' | 'rpm', buildDir: string, applicationName: string, arch: string): Promise<string[]> {
	if (packageType === 'deb') {
		if (!isDebianArchString(arch)) {
			throw new Error('Invalid Debian arch string ' + arch);
		}
	}
	if (packageType === 'rpm' && !isRpmArchString(arch)) {
		throw new Error('Invalid RPM arch string ' + arch);
	}

	// Get the files for which we want to find dependencies.
	// Native modules are unpacked next to the ASAR archive in `node_modules.asar.unpacked`.
	const nativeModulesPath = path.join(buildDir, 'resources', 'app', 'node_modules.asar.unpacked');
	const findResult = spawnSync('find', [nativeModulesPath, '-name', '*.node']);
	if (findResult.status) {
		console.error('Error finding files:');
		console.error(findResult.stderr.toString());
		return [];
	}

	const appPath = path.join(buildDir, applicationName);
	// Add the native modules
	const candidates = findResult.stdout.toString().trimEnd().split('\n');
	// Add the tunnel binary.
	candidates.push(path.join(buildDir, 'bin', product.tunnelApplicationName));
	// Add the main executable.
	candidates.push(appPath);
	// Add chrome sandbox and crashpad handler.
	candidates.push(path.join(buildDir, 'chrome-sandbox'));
	candidates.push(path.join(buildDir, 'chrome_crashpad_handler'));

	/*
	 * Only what the build actually produced.
	 *
	 * This fork does not build the tunnel CLI, so `bin/<name>-tunnel` is not
	 * there — and dpkg-shlibdeps does not merely skip a path it cannot read,
	 * it exits 25 and takes the whole package with it. A binary that is not
	 * shipped contributes no runtime dependencies, so leaving it out is the
	 * correct answer rather than a workaround; the log below says which files
	 * were skipped so a missing one that *should* have been built is visible
	 * instead of silent.
	 */
	const files = candidates.filter(file => existsSync(file));
	const missing = candidates.filter(file => !existsSync(file));
	if (missing.length > 0) {
		console.log('Not built, so not scanned for dependencies:\n  ' + missing.join('\n  '));
	}

	// Generate the dependencies.
	let dependencies: Set<string>[];
	if (packageType === 'deb') {
		const chromiumSysroot = await getChromiumSysroot(arch as DebianArchString);
		const vscodeSysroot = await getVSCodeSysroot(arch as DebianArchString);
		dependencies = generatePackageDepsDebian(files, arch as DebianArchString, chromiumSysroot, vscodeSysroot);
	} else {
		dependencies = generatePackageDepsRpm(files);
	}

	// Merge all the dependencies.
	const mergedDependencies = mergePackageDeps(dependencies);

	// Exclude bundled dependencies and sort
	const sortedDependencies: string[] = Array.from(mergedDependencies).filter(dependency => {
		return !bundledDeps.some(bundledDep => dependency.startsWith(bundledDep));
	}).sort();

	const referenceGeneratedDeps = packageType === 'deb' ?
		debianGeneratedDeps[arch as DebianArchString] :
		rpmGeneratedDeps[arch as RpmArchString];
	/*
	 * The reference list comes from a build that ships the tunnel CLI; this
	 * one does not, so a *shorter* list is the expected outcome here and
	 * failing on it would mean this fork could never package at all.
	 *
	 * What the check is actually for is the opposite direction: a dependency
	 * appearing that nobody reviewed, which is how a package starts refusing
	 * to install on a distribution it used to support. That still fails.
	 */
	const reference = new Set(referenceGeneratedDeps);
	const added = sortedDependencies.filter(dependency => !reference.has(dependency));
	const removed = referenceGeneratedDeps.filter(dependency => !sortedDependencies.includes(dependency));
	if (added.length > 0) {
		throw new Error('The dependencies list gained entries that are not in the reviewed list.'
			+ '\nNew:\n' + added.join('\n')
			+ '\nFull list:\n' + sortedDependencies.join('\n'));
	}
	if (removed.length > 0 && FAIL_BUILD_FOR_NEW_DEPENDENCIES) {
		console.warn('The dependencies list is shorter than the reviewed one, which is what not shipping the tunnel CLI looks like.'
			+ '\nAbsent:\n' + removed.join('\n'));
	}

	return sortedDependencies;
}


// Based on https://source.chromium.org/chromium/chromium/src/+/main:chrome/installer/linux/rpm/merge_package_deps.py.
function mergePackageDeps(inputDeps: Set<string>[]): Set<string> {
	const requires = new Set<string>();
	for (const depSet of inputDeps) {
		for (const dep of depSet) {
			const trimmedDependency = dep.trim();
			if (trimmedDependency.length && !trimmedDependency.startsWith('#')) {
				requires.add(trimmedDependency);
			}
		}
	}
	return requires;
}
