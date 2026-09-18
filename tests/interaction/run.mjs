/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Fintech-owned interaction harness: launches the sibling Konjugate app with a scratch userData
// containing the freshly built fintech packages, then checks they show up in the real UI, that the
// reference model runs and forks, and that the same model wired up from the plugin's component
// bundles behaves identically. Konjugate's own interaction runner cannot be extended from
// outside, so this drives the app through Playwright instead.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModels, writeNodesOnlyInterbankRun } from '../../scripts/buildModels.mjs';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { konjugateDir } from '../../scripts/konjugatePaths.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');

const targetTime = 40;
const banks = ['Bank A', 'Bank B', 'Bank C'];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const scratch = await mkdtemp(join(tmpdir(), 'konjugate-fintech-'));
const userData = join(scratch, 'userData');

// Launches Konjugate on `modelPath` and hands `scenario` a small toolkit; always closes the app.
async function withApp(modelPath, scenario) {
    const app = await electron.launch({
        executablePath: electronPath,
        args: [konjugateDir, `--user-data-dir=${userData}`, modelPath],
        env
    });
    try {
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
        await window.waitForSelector('#runButton:not([disabled])', { timeout: 30000 });
        const finalSamples = async () => {
            const jobIds = await app.evaluate(() => globalThis.fintechJobIds);
            return Promise.all(jobIds.map((jobId) => window.evaluate(([id, time]) => window.engine.readResultSample(id, time), [jobId, targetTime])));
        };
        const runToTarget = async () => {
            await window.click('#runButton');
            await window.evaluate((time) => {
                document.querySelector('#runOnlineMode').checked = false;
                document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true }));
                document.querySelector('#runTargetTime').value = time;
            }, String(targetTime));
            await window.click('#startRun');
            await window.waitForFunction(() => !document.querySelector('#forkHereButton').hidden, null, { timeout: 60000 });
        };
        return await scenario({ app, window, finalSamples, runToTarget });
    } finally {
        await app.close().catch(() => {});
    }
}

const stateValueIn = (states) => (sample, name) => sample.states.find((state) => state.stateId === states[name]).value;

// Total money and every bank's balance-sheet identity must hold in any sample.
function conservationChecks(stateValue) {
    // Every bank's reserves, the wallets, the central bank and the fire-sale buyers' cash.
    const totalMoney = (sample) => [...banks.map((bank) => `${bank}.reserves`), 'Depositor wallets.cash', 'Central bank.reserves', 'Asset market.cash']
        .reduce((total, name) => total + stateValue(sample, name), 0);
    // reserves + loans = deposits + equity + interbank borrowing.
    const balanceGap = (sample, bank) => stateValue(sample, `${bank}.reserves`) + stateValue(sample, `${bank}.loans`) -
        stateValue(sample, `${bank}.deposits`) - stateValue(sample, `${bank}.equity`) - stateValue(sample, `${bank}.interbank`);
    return (sample, label) => {
        assert.ok(Math.abs(totalMoney(sample) - 2300) < 1e-6, `${label}: money was not conserved (${totalMoney(sample)})`);
        for (const bank of banks) assert.ok(Math.abs(balanceGap(sample, bank)) < 1e-6, `${label}: ${bank} balance sheet is off by ${balanceGap(sample, bank)}`);
    };
}

// Fork at day 12 with `lending` M/day of emergency lending, run to the target, return the new sample.
async function forkWithLending({ window, finalSamples }, lending) {
    await window.evaluate((day) => {
        const timeline = document.querySelector('#resultTimeline');
        timeline.value = day;
        timeline.dispatchEvent(new Event('input', { bubbles: true }));
    }, '12');
    await window.click('#forkHereButton');
    await window.waitForSelector('#forkParameterPanel:not([hidden])');
    // One shared knob drives both legs of the lending facility, so the fork panel offers exactly one row.
    assert.equal(await window.locator('#forkParameterRows .liveParameterRow').count(), 1, 'Shared parameter should appear once');
    const input = '#forkParameterRows input[aria-label="Emergency lending value"]';
    await window.fill(input, String(lending));
    await window.dispatchEvent(input, 'change');
    await window.click('#confirmForkParameters');
    await window.waitForSelector('#runLaunchDialog[open]');
    await window.evaluate((time) => { document.querySelector('#runOnlineMode').checked = false; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runTargetTime').value = time; }, String(targetTime));
    await window.click('#startRun');
    await window.waitForFunction(() => document.querySelectorAll('#branchChips > *').length === 2 && document.querySelector('#statusText').textContent === 'Simulation complete', null, { timeout: 60000 });
    return (await finalSamples()).at(-1);
}

try {
    await installBuiltPackages(userData);
    const [{ path: interbankModel, states }] = await buildModels(join(scratch, 'models'));
    const stateValue = stateValueIn(states);
    const assertConserved = conservationChecks(stateValue);

    // --- Scenario 1: the script-built reference model runs, conserves, and forks. -----------------
    const reference = await withApp(interbankModel, async (session) => {
        const { window, finalSamples, runToTarget } = session;
        // Component library: the plugin's finance templates and bundles are discoverable.
        const components = await window.evaluate(() => window.componentLibrary.list());
        const finance = components.filter((component) => component.domains?.includes('finance'));
        const kindOf = (id) => finance.find((component) => component.id === id)?.kind;
        for (const id of ['commercialBank', 'depositorWallets', 'centralBank', 'assetMarket', 'liquidityPoolAmm']) assert.equal(kindOf(id), 'node', `Missing finance node ${id}`);
        assert.equal(kindOf('liquidityFlow'), 'edge', 'Missing finance edge liquidityFlow');
        for (const id of ['depositRun', 'fireSale', 'interbankLending', 'emergencyLending']) {
            assert.equal(finance.find((component) => component.id === id)?.kind, 'bundle', `Missing finance bundle ${id}`);
        }
        console.log(`Finance components: ${finance.map((component) => component.id).join(', ')}`);

        await runToTarget();
        const [baseline] = await finalSamples();
        assertConserved(baseline, 'Baseline');
        assert.ok(stateValue(baseline, 'Bank A.equity') < 50, 'Bank A should book fire-sale losses');
        assert.ok(stateValue(baseline, 'Bank B.equity') < 50, 'Fire-sale losses should spread to bank B');
        assert.ok(stateValue(baseline, 'Asset market.holdings') > 0, 'Loans should have been fire-sold');
        console.log(`Baseline: equity A ${stateValue(baseline, 'Bank A.equity').toFixed(1)}, B ${stateValue(baseline, 'Bank B.equity').toFixed(1)}, C ${stateValue(baseline, 'Bank C.equity').toFixed(1)}; balance sheets and total money conserved.`);

        const fork = await forkWithLending(session, 15);
        const [parent] = await finalSamples();
        assert.equal(stateValue(parent, 'Bank A.reserves'), stateValue(baseline, 'Bank A.reserves'), 'Forking must not alter the parent branch');
        assertConserved(fork, 'Fork');
        assert.ok(stateValue(fork, 'Bank A.equity') > stateValue(baseline, 'Bank A.equity') + 5, 'Injection should limit bank A losses');
        assert.ok(stateValue(fork, 'Asset market.holdings') < stateValue(baseline, 'Asset market.holdings'), 'Injection should reduce fire sales');
        console.log(`Fork with injection: equity A ${stateValue(fork, 'Bank A.equity').toFixed(1)} (baseline ${stateValue(baseline, 'Bank A.equity').toFixed(1)}), fire-sold ${stateValue(fork, 'Asset market.holdings').toFixed(0)} vs ${stateValue(baseline, 'Asset market.holdings').toFixed(0)}.`);
        return { baseline, fork };
    });

    // --- Scenario 2: the same model wired up from the component bundles behaves identically. ------
    const nodesOnly = await writeNodesOnlyInterbankRun(join(scratch, 'nodesOnly.kjt'));
    await withApp(nodesOnly.path, async (session) => {
        const { window, finalSamples, runToTarget } = session;
        const stateValueBundled = stateValueIn(nodesOnly.states);
        const edgeCount = () => window.evaluate(() => Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\d+/)[0]));
        await window.click('#componentLibraryButton');
        await window.waitForSelector('#componentLibraryPanel:not([hidden])');

        // Select exactly `names` (first name first), then click the bundle.
        const applyBundle = async (bundleId, names, expectedEdges) => {
            const before = await edgeCount();
            await window.evaluate((ids) => window.__debugTransform.selectExactly(ids), names.map((name) => nodesOnly.nodes[name]));
            await window.click(`[data-template-id="${bundleId}"]`);
            await window.waitForFunction(([count, expected]) => Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\d+/)[0]) === count + expected, [before, expectedEdges], { timeout: 10000 })
                .catch(async () => { throw new Error(`Bundle ${bundleId} on ${names.join(', ')} did not add ${expectedEdges} edges: ${await window.textContent('#componentLibraryHint')}`); });
        };
        await applyBundle('depositRun', ['Bank A', 'Depositor wallets'], 2);
        for (const bank of banks) await applyBundle('fireSale', [bank, 'Asset market'], 3);
        await applyBundle('interbankLending', ['Bank A', 'Bank B'], 2);
        await applyBundle('interbankLending', ['Bank B', 'Bank C'], 2);
        await applyBundle('interbankLending', ['Bank A', 'Bank C'], 2);
        await applyBundle('emergencyLending', ['Central bank', 'Bank A'], 2);
        assert.equal(await edgeCount(), 19, 'The bundles should add the same 19 edges as the script-built model.');

        // Project-scoped constants are one definition each; the lending facility keeps its own live knob.
        await window.click('#parametersButton');
        await window.waitForSelector('#parametersPanel:not([hidden])');
        assert.equal(await window.textContent('#parametersSummary'), '8 parameters · 8 shared');

        await runToTarget();
        const [baseline] = await finalSamples();
        assertConserved(baseline, 'Bundle-wired baseline');
        for (const name of Object.keys(nodesOnly.states)) {
            assert.ok(Math.abs(stateValueBundled(baseline, name) - stateValue(reference.baseline, name)) < 1e-6,
                `${name}: bundle-wired model ${stateValueBundled(baseline, name)} vs script-built ${stateValue(reference.baseline, name)}`);
        }
        const fork = await forkWithLending(session, 15);
        assertConserved(fork, 'Bundle-wired fork');
        assert.ok(Math.abs(stateValueBundled(fork, 'Bank A.equity') - stateValue(reference.fork, 'Bank A.equity')) < 1e-6, 'The bundle-wired fork must match the script-built fork.');
        console.log(`Bundle-wired model matches the script-built one: baseline and fork agree on every state (equity A ${stateValueBundled(fork, 'Bank A.equity').toFixed(1)} with lending).`);
    });
    console.log('Fintech interaction checks passed.');
} finally {
    await rm(scratch, { recursive: true, force: true });
}
