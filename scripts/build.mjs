/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildModels } from './buildModels.mjs';
import { fintechRoot, konjugateModule } from './konjugatePaths.mjs';

const { createPackageArchive } = await import(pathToFileURL(konjugateModule('src/packageArchive.mjs')));

const packageDirectory = join(fintechRoot, 'packages', 'engine');
const outputDirectory = join(fintechRoot, 'out');

const manifest = JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8'));
const files = {};
// Example models are generated from scripts/buildModels.mjs into out/models and shipped inside the
// package, next to a hand-written guide from guides/, so the package always carries the model the
// generator currently writes.
const builtModels = await buildModels(join(outputDirectory, 'models'));
for (const contribution of manifest.contributes) {
    if (contribution.kind === 'example') {
        const built = builtModels.find((model) => model.name === contribution.exampleId);
        if (!built) throw new Error(`No generated model for example ${contribution.exampleId}.`);
        files[contribution.entry] = await readFile(built.path);
        if (contribution.guide) files[contribution.guide] = await readFile(join(fintechRoot, 'guides', `${contribution.exampleId}.md`));
    } else {
        files[contribution.entry] = await readFile(join(packageDirectory, contribution.entry));
    }
}
const archive = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'plugin',
        packageId: manifest.pluginId, name: manifest.name, version: manifest.version,
        contents: { manifest: 'plugin.json' }
    },
    contributionManifest: manifest,
    files
});
await mkdir(outputDirectory, { recursive: true });
const target = join(outputDirectory, `${manifest.pluginId}-${manifest.version}.kjp`);
await writeFile(target, archive);
console.log(`Built ${target}`);

// ---- the Start add-on (a launcher) -------------------------------------------------------------------
// It carries its own copy of the bundle and node definitions its importer builds models from, taken from
// the plugin's components at build time so the two can never drift.
const startDirectory = join(fintechRoot, 'packages', 'start');
const startManifest = JSON.parse(await readFile(join(startDirectory, 'addon.json'), 'utf8'));
const startFiles = {};
const collect = async (directory, prefix = '') => {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await collect(directory, relative);
        else if (relative !== 'addon.json') startFiles[relative] = await readFile(join(directory, relative));
    }
};
await collect(startDirectory);
for (const id of ['commercialBank', 'depositorWallets', 'centralBank', 'assetMarket', 'depositRun', 'fireSale', 'interbankLendingScaled', 'interbankDefault', 'emergencyLending']) {
    startFiles[`bundles/${id}.json`] = await readFile(join(packageDirectory, 'components', `${id}.json`));
}
const startArchive = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'addon',
        packageId: startManifest.addonId, name: startManifest.name, version: startManifest.version,
        contents: { manifest: 'addon.json' }
    },
    contributionManifest: startManifest,
    files: startFiles
});
const startTarget = join(outputDirectory, `${startManifest.addonId}-${startManifest.version}.kja`);
await writeFile(startTarget, startArchive);
console.log(`Built ${startTarget}`);

// ---- the Markets add-on (a launcher) -----------------------------------------------------------------
// Self-contained: its importer, analysis library and sample series are all inside the package.
const marketsDirectory = join(fintechRoot, 'packages', 'markets');
const marketsManifest = JSON.parse(await readFile(join(marketsDirectory, 'addon.json'), 'utf8'));
const marketsFiles = {};
const collectMarkets = async (prefix = '') => {
    for (const entry of await readdir(join(marketsDirectory, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await collectMarkets(relative);
        else if (relative !== 'addon.json') marketsFiles[relative] = await readFile(join(marketsDirectory, relative));
    }
};
await collectMarkets();
const marketsArchive = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'addon',
        packageId: marketsManifest.addonId, name: marketsManifest.name, version: marketsManifest.version,
        contents: { manifest: 'addon.json' }
    },
    contributionManifest: marketsManifest,
    files: marketsFiles
});
const marketsTarget = join(outputDirectory, `${marketsManifest.addonId}-${marketsManifest.version}.kja`);
await writeFile(marketsTarget, marketsArchive);
console.log(`Built ${marketsTarget}`);
