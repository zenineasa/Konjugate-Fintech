/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Fintech-owned interaction harness: launches the sibling Konjugate app with a scratch userData
// containing the freshly built fintech packages, then checks they show up in the real UI and that
// the reference models run and fork. Konjugate's own interaction runner cannot be extended from
// outside, so this drives the app through Playwright instead.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModels } from '../../scripts/buildModels.mjs';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { konjugateDir } from '../../scripts/konjugatePaths.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');

const scratch = await mkdtemp(join(tmpdir(), 'konjugate-fintech-'));
const userData = join(scratch, 'userData');
const modelsDirectory = join(scratch, 'models');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let app;
try {
    await installBuiltPackages(userData);
    const [interbankModel] = await buildModels(modelsDirectory);
    app = await electron.launch({
        executablePath: electronPath,
        args: [konjugateDir, `--user-data-dir=${userData}`, interbankModel],
        env
    });
    // Test-only: remember every engine job so results can be read back by id.
    await app.evaluate(({ ipcMain }) => {
        globalThis.fintechJobIds = [];
        const original = ipcMain._invokeHandlers.get('engineStart');
        ipcMain._invokeHandlers.set('engineStart', async (...args) => {
            const execution = await original(...args);
            globalThis.fintechJobIds.push(execution.jobId);
            return execution;
        });
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => typeof window.componentLibrary?.list === 'function');

    // Component library: the plugin's finance templates are discoverable.
    const components = await window.evaluate(() => window.componentLibrary.list());
    const finance = components.filter((component) => component.domains?.includes('finance')).map((component) => component.id);
    for (const id of ['commercialBank', 'liquidityPoolAmm', 'liquidityFlow']) {
        assert.ok(finance.includes(id), `Missing finance component ${id}`);
    }
    console.log(`Finance components: ${finance.join(', ')}`);

    // Reference model: run the interbank liquidity run to day 40.
    const targetTime = 40;
    await window.waitForSelector('#runButton:not([disabled])', { timeout: 30000 });
    await window.click('#runButton');
    await window.evaluate((time) => {
        document.querySelector('#runOnlineMode').checked = false;
        document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#runTargetTime').value = time;
    }, String(targetTime));
    await window.click('#startRun');
    await window.waitForFunction(() => !document.querySelector('#forkHereButton').hidden, null, { timeout: 60000 });

    const finalSamples = async () => {
        const jobIds = await app.evaluate(() => globalThis.fintechJobIds);
        return Promise.all(jobIds.map((jobId) => window.evaluate(([id, time]) => window.engine.readResultSample(id, time), [jobId, targetTime])));
    };
    // State ids follow model construction order: bank A reserves is 2, B 5, C 8, wallets 11, central bank 13.
    const stateValue = (sample, stateId) => sample.states.find((state) => state.stateId === stateId).value;
    const [baseline] = await finalSamples();
    const totalMoney = (sample) => [2, 5, 8, 11, 13].reduce((total, id) => total + stateValue(sample, id), 0);
    assert.ok(Math.abs(totalMoney(baseline) - 1300) < 1e-6, `Money was not conserved: ${totalMoney(baseline)}`);
    assert.ok(stateValue(baseline, 2) < 0, 'Baseline run should exhaust bank A reserves');
    assert.ok(stateValue(baseline, 5) < 100, 'Stress should spread to bank B');
    console.log(`Baseline: bank A reserves ${stateValue(baseline, 2).toFixed(1)}, bank B ${stateValue(baseline, 5).toFixed(1)}; total money conserved.`);

    // Fork at day 12 with a central-bank injection and compare against the untouched baseline.
    await window.evaluate((day) => {
        const timeline = document.querySelector('#resultTimeline');
        timeline.value = day;
        timeline.dispatchEvent(new Event('input', { bubbles: true }));
    }, '12');
    await window.click('#forkHereButton');
    await window.waitForSelector('#forkParameterPanel:not([hidden])');
    await window.fill('#forkParameterRows input[aria-label="Injection value"]', '15');
    await window.dispatchEvent('#forkParameterRows input[aria-label="Injection value"]', 'change');
    await window.click('#confirmForkParameters');
    await window.waitForSelector('#runLaunchDialog[open]');
    await window.evaluate((time) => { document.querySelector('#runOnlineMode').checked = false; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runTargetTime').value = time; }, String(targetTime));
    await window.click('#startRun');
    await window.waitForFunction(() => document.querySelectorAll('#branchChips > *').length === 2 && document.querySelector('#statusText').textContent === 'Simulation complete', null, { timeout: 60000 });
    const [parent, fork] = await finalSamples();
    assert.equal(stateValue(parent, 2), stateValue(baseline, 2), 'Forking must not alter the parent branch');
    assert.ok(stateValue(fork, 2) > stateValue(baseline, 2) + 50, `Injection should lift bank A reserves (fork ${stateValue(fork, 2)}, baseline ${stateValue(baseline, 2)})`);
    assert.ok(Math.abs(totalMoney(fork) - 1300) < 1e-6, 'Money must stay conserved across the fork');
    console.log(`Fork with injection: bank A reserves ${stateValue(fork, 2).toFixed(1)} (baseline ${stateValue(baseline, 2).toFixed(1)}).`);
    console.log('Fintech interaction checks passed.');
} finally {
    await app?.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
}
