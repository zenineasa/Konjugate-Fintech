/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Fintech-owned interaction harness: launches the sibling Konjugate app with a scratch userData
// containing the freshly built fintech packages, then checks they show up in the real UI.
// Konjugate's own interaction runner cannot be extended from outside, so this drives the app
// through Playwright instead.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { konjugateDir } from '../../scripts/konjugatePaths.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');

const userData = await mkdtemp(join(tmpdir(), 'konjugate-fintech-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let app;
try {
    await installBuiltPackages(userData);
    app = await electron.launch({
        executablePath: electronPath,
        args: [konjugateDir, `--user-data-dir=${userData}`],
        env
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => typeof window.componentLibrary?.list === 'function');

    const components = await window.evaluate(() => window.componentLibrary.list());
    const fintech = components.filter((component) => component.domains?.includes('finance'));
    console.log(`Finance components: ${fintech.map((component) => component.id).join(', ')}`);
    for (const id of ['commercialBank', 'liquidityPoolAmm', 'liquidityFlow']) {
        assert.ok(fintech.some((component) => component.id === id), `Missing finance component ${id}`);
    }
    console.log('Fintech interaction checks passed.');
} finally {
    await app?.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
}
