/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Regenerates the Examples Explorer preview screenshots for this plugin's own examples, the same
// way Konjugate core regenerates its bundled examples' thumbnails (tests/generateExampleThumbnails.mjs
// there): by actually driving the running app -- opening each example, fitting the camera, and
// capturing the canvas -- rather than hand-authoring images that would silently drift from the
// real model over time. Unlike core's script, this drives the app from the outside via Playwright
// (core's own script runs inside the Electron main process, which this repo doesn't have access
// to), and writes into thumbnails/ at this repo's root rather than a bundled examples/ directory,
// since these examples are plugin-contributed, not core-bundled.
//
// Run via `npm run generate:example-thumbnails` whenever an example's layout or content changes,
// or a new example is added; then re-run `npm run install:dev`/`node scripts/build.mjs` to bundle
// the refreshed images (build.mjs reads them from here into each example's declared `thumbnail`
// path -- see plugin.json).

import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModels } from './buildModels.mjs';
import { installBuiltPackages } from './installDev.mjs';
import { fintechRoot, konjugateDir } from './konjugatePaths.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');

const thumbnailsDir = join(fintechRoot, 'thumbnails');
await mkdir(thumbnailsDir, { recursive: true });

const scratch = await mkdtemp(join(tmpdir(), 'konjugate-fintech-thumbnails-'));
const userData = join(scratch, 'userData');
await installBuiltPackages(userData);
await buildModels(join(scratch, 'models'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: electronPath, args: [konjugateDir, `--user-data-dir=${userData}`], env });
try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => typeof window.componentLibrary?.list === 'function');

    // Loading a second example while the first is unsaved-dirty raises a native "Discard changes?"
    // dialog that Playwright can't click directly -- auto-answer it via the main process, the same
    // way core's own thumbnail script does from inside it.
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });

    const exampleIds = await window.evaluate(() => window.projectFiles.listExamples().then(
        (examples) => examples.filter((e) => e.source?.pluginId === 'konjugate.fintech.engine').map((e) => e.id)
    ));
    if (exampleIds.length === 0) throw new Error('No konjugate.fintech.engine examples were found -- is the plugin installed?');
    console.log(`Found ${exampleIds.length} example(s): ${exampleIds.join(', ')}`);

    for (const id of exampleIds) {
        await window.click('#exampleButton');
        await window.waitForSelector('#examplesExplorerDialog[open]');
        await window.click(`.examplesExplorerItem[data-example-id="${id}"]`);
        await window.click('#examplesExplorerLoad');
        // Not waitForSelector: a closed <dialog> has no [open] attribute but is also not "visible"
        // (display:none via the UA stylesheet), so a selector-based wait for ":not([open])" would
        // wait forever for a state (visible AND closed) that can never both hold.
        await window.waitForFunction(() => !document.querySelector('#examplesExplorerDialog').open);
        await window.waitForSelector('.node-label-container');
        await window.click('.cubeFit');
        // Let the fit-to-view camera move settle before capturing.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const pngName = id.replace(/\.kjt$/, '.png');
        await window.locator('#canvas').screenshot({ path: join(thumbnailsDir, pngName) });
        console.log(`wrote thumbnails/${pngName}`);
    }
} finally {
    await app.close().catch(() => {});
}
