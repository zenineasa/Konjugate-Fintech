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

test('every contributed component passes Konjugate\'s template validator', async () => {
    for (const contribution of manifest.contributes) {
        const template = JSON.parse(await readFile(join(packageDirectory, contribution.entry), 'utf8'));
        assert.equal(template.id, contribution.componentId);
        assert.ok(template.domains.includes('finance'));
        validateComponentTemplate(template);
    }
});

test('no component file is left uncontributed', async () => {
    const files = (await readdir(join(packageDirectory, 'components'))).sort();
    const contributed = manifest.contributes.map((entry) => entry.entry.replace('components/', '')).sort();
    assert.deepEqual(files, contributed);
});
