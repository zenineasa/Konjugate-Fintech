/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateModule } from '../../scripts/konjugatePaths.mjs';

const { validateComponentTemplate } = await import(pathToFileURL(konjugateModule('src/componentTemplate.mjs')));
const packageDirectory = join(fintechRoot, 'packages', 'engine');
const manifest = JSON.parse(await readFile(join(packageDirectory, 'plugin.json'), 'utf8'));
const componentContributions = manifest.contributes.filter((contribution) => contribution.kind === 'component');
const exampleContributions = manifest.contributes.filter((contribution) => contribution.kind === 'example');

test('every contributed component passes Konjugate\'s template validator', async () => {
    for (const contribution of componentContributions) {
        const template = JSON.parse(await readFile(join(packageDirectory, contribution.entry), 'utf8'));
        assert.equal(template.id, contribution.componentId);
        assert.ok(template.domains.includes('finance'));
        validateComponentTemplate(template);
    }
});

test('no component file is left uncontributed', async () => {
    const files = (await readdir(join(packageDirectory, 'components'))).sort();
    const contributed = componentContributions.map((entry) => entry.entry.replace('components/', '')).sort();
    assert.deepEqual(files, contributed);
});

test('every contributed example has a generated model and a guide, and every guide is contributed', async () => {
    const { buildModels } = await import('../../scripts/buildModels.mjs');
    const built = new Set((await buildModels(join(fintechRoot, 'out', 'models'))).map((model) => model.name));
    const guides = (await readdir(join(fintechRoot, 'guides'))).map((name) => name.replace(/\.md$/, '')).sort();
    assert.deepEqual(exampleContributions.map((entry) => entry.exampleId).sort(), guides);
    for (const contribution of exampleContributions) {
        assert.ok(built.has(contribution.exampleId), `No generated model for ${contribution.exampleId}`);
        assert.equal(contribution.entry, `examples/${contribution.exampleId}.kjt`);
        assert.equal(contribution.guide, `examples/${contribution.exampleId}.md`);
        assert.ok(contribution.domains.includes('finance'));
    }
});
