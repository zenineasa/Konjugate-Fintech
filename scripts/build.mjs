/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
