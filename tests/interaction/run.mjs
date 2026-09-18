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
import { buildModels, writeNodesOnlyModel } from '../../scripts/buildModels.mjs';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { konjugateDir } from '../../scripts/konjugatePaths.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');

const banks = ['Bank A', 'Bank B', 'Bank C'];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const scratch = await mkdtemp(join(tmpdir(), 'konjugate-fintech-'));
const userData = join(scratch, 'userData');

// Launches Konjugate on `modelPath` and hands `scenario` a small toolkit; always closes the app.
async function withApp(modelPath, scenario, { targetTime = 60 } = {}) {
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
        return await scenario({ app, window, finalSamples, runToTarget, targetTime });
    } finally {
        await app.close().catch(() => {});
    }
}

const stateValueIn = (states) => (sample, name) => sample.states.find((state) => state.stateId === states[name]).value;

// Total money and every bank's balance-sheet identity must hold in any sample.
function conservationChecks(stateValue) {
    // Every bank's reserves, the wallets, the central bank and the fire-sale buyers' cash. (Interbank
    // claims and borrowing are balance-sheet entries between banks, not money, so they are not counted.)
    const totalMoney = (sample) => [...banks.map((bank) => `${bank}.reserves`), 'Depositor wallets.cash', 'Central bank.reserves', 'Asset market.cash']
        .reduce((total, name) => total + stateValue(sample, name), 0);
    // reserves + loans + interbank claims = deposits + equity + interbank borrowing.
    const balanceGap = (sample, bank) => stateValue(sample, `${bank}.reserves`) + stateValue(sample, `${bank}.loans`) + stateValue(sample, `${bank}.claims`) -
        stateValue(sample, `${bank}.deposits`) - stateValue(sample, `${bank}.equity`) - stateValue(sample, `${bank}.borrowing`);
    return (sample, label) => {
        assert.ok(Math.abs(totalMoney(sample) - 2300) < 1e-6, `${label}: money was not conserved (${totalMoney(sample)})`);
        for (const bank of banks) assert.ok(Math.abs(balanceGap(sample, bank)) < 1e-6, `${label}: ${bank} balance sheet is off by ${balanceGap(sample, bank)}`);
    };
}

// Fork the branch at index `parent` at `day` with the given live-parameter values (by name), run to
// the target, and return the new branch's final sample.
async function forkWith({ window, finalSamples, targetTime }, parent, values, { day = 12, liveRows = 2 } = {}) {
    const chips = window.locator('#branchChips > *');
    if (parent > 0 || await chips.count() > 1) await chips.nth(parent).click();
    await window.evaluate((day) => {
        const timeline = document.querySelector('#resultTimeline');
        timeline.value = day;
        timeline.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(day));
    const branchesBefore = (await finalSamples()).length;
    await window.click('#forkHereButton');
    await window.waitForSelector('#forkParameterPanel:not([hidden])');
    // Each shared live parameter is one row, however many edges link to it: emergency lending drives
    // both legs of the facility, and the base haircut every bank's fire sales.
    assert.equal(await window.locator('#forkParameterRows .liveParameterRow').count(), liveRows, 'Each shared live parameter should appear once');
    for (const [name, value] of Object.entries(values)) {
        const input = `#forkParameterRows input[aria-label="${name} value"]`;
        await window.fill(input, String(value));
        await window.dispatchEvent(input, 'change');
    }
    await window.click('#confirmForkParameters');
    await window.waitForSelector('#runLaunchDialog[open]');
    await window.evaluate((time) => { document.querySelector('#runOnlineMode').checked = false; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runTargetTime').value = time; }, String(targetTime));
    await window.click('#startRun');
    await window.waitForFunction(([count]) => document.querySelectorAll('#branchChips > *').length === count && document.querySelector('#statusText').textContent === 'Simulation complete', [branchesBefore + 1], { timeout: 90000 });
    return (await finalSamples()).at(-1);
}

// Opens the component library and returns helpers to apply bundles to a nodes-only project through
// the real UI: select exactly `names` (first name first), click the bundle, expect its edges.
async function bundleWiring(window, nodesOnly) {
    const edgeCount = () => window.evaluate(() => Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\d+/)[0]));
    await window.click('#componentLibraryButton');
    await window.waitForSelector('#componentLibraryPanel:not([hidden])');
    const applyBundle = async (bundleId, names, expectedEdges) => {
        const before = await edgeCount();
        await window.evaluate((ids) => window.__debugTransform.selectExactly(ids), names.map((name) => nodesOnly.nodes[name]));
        await window.click(`[data-template-id="${bundleId}"]`);
        await window.waitForFunction(([count, expected]) => Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\d+/)[0]) === count + expected, [before, expectedEdges], { timeout: 10000 })
            .catch(async () => { throw new Error(`Bundle ${bundleId} on ${names.join(', ')} did not add ${expectedEdges} edges: ${await window.textContent('#componentLibraryHint')}`); });
    };
    return { applyBundle, edgeCount };
}

try {
    await installBuiltPackages(userData);
    const built = await buildModels(join(scratch, 'models'));
    const { path: interbankModel, states } = built.find((model) => model.name === 'interbankLiquidityRun');
    const defiModel = built.find((model) => model.name === 'defiLiquidationCascade');
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
        // The run drains bank A, which becomes insolvent and passes its shortfall to its creditors.
        assert.ok(stateValue(baseline, 'Bank A.equity') < 0, 'Bank A should be insolvent by the end of the run');
        assert.ok(stateValue(baseline, 'Bank A.borrowing') > 0, 'Bank A should have borrowed from its peers');
        assert.ok(stateValue(baseline, 'Bank B.claims') > 0 && stateValue(baseline, 'Bank C.claims') > 0, 'Banks B and C should be creditors of bank A');
        assert.ok(stateValue(baseline, 'Bank B.equity') < 25 && stateValue(baseline, 'Bank B.equity') > 0, 'Bank B should be hurt by its exposure but still solvent');
        assert.ok(stateValue(baseline, 'Asset market.holdings') > 0, 'Loans should have been fire-sold');
        const equities = (sample) => banks.map((bank) => stateValue(sample, `${bank}.equity`).toFixed(1)).join(' / ');
        console.log(`Baseline equity A/B/C: ${equities(baseline)}; balance sheets and total money conserved.`);

        // Policy response: emergency lending at day 12 keeps bank A solvent and limits the losses it passes on.
        const lending = await forkWith(session, 0, { 'Emergency lending': 15 });
        const [parent] = await finalSamples();
        assert.equal(stateValue(parent, 'Bank A.reserves'), stateValue(baseline, 'Bank A.reserves'), 'Forking must not alter the parent branch');
        assertConserved(lending, 'Lending fork');
        assert.ok(stateValue(lending, 'Bank A.equity') > 0, 'Emergency lending should keep bank A solvent');
        assert.ok(stateValue(lending, 'Bank B.equity') > stateValue(baseline, 'Bank B.equity') + 5, 'Emergency lending should spare bank B');
        console.log(`Emergency lending fork equity A/B/C: ${equities(lending)}`);

        // Fresh shock: a fire-sale haircut of 0.25 at day 12 deepens the losses and pushes the creditors in too.
        const shock = await forkWith(session, 0, { 'Base haircut': 0.25 });
        assertConserved(shock, 'Shock fork');
        assert.ok(stateValue(shock, 'Bank B.equity') < stateValue(baseline, 'Bank B.equity') - 5, 'A harsher haircut should deepen bank B\'s losses');
        console.log(`Haircut shock fork equity A/B/C: ${equities(shock)}`);
        const fork = lending;
        return { baseline, fork, shock };
    });

    // --- Scenario 2: the same model wired up from the component bundles behaves identically. ------
    const nodesOnly = await writeNodesOnlyModel('interbankLiquidityRun', join(scratch, 'nodesOnly.kjt'));
    await withApp(nodesOnly.path, async (session) => {
        const { window, finalSamples, runToTarget } = session;
        const stateValueBundled = stateValueIn(nodesOnly.states);
        const { applyBundle, edgeCount } = await bundleWiring(window, nodesOnly);

        await applyBundle('depositRun', ['Bank A', 'Depositor wallets'], 2);
        for (const bank of banks) await applyBundle('fireSale', [bank, 'Asset market'], 3);
        // Banks lend in both directions, and each bank's interbank debt is split between the other two.
        for (const lender of banks) {
            for (const borrower of banks.filter((bank) => bank !== lender)) {
                await applyBundle('interbankLending', [lender, borrower], 3);
                await applyBundle('interbankDefault', [borrower, lender], 4);
            }
        }
        await applyBundle('emergencyLending', ['Central bank', 'Bank A'], 2);
        assert.equal(await edgeCount(), 2 + 9 + 6 * 3 + 6 * 4 + 2, 'The bundles should add the same 55 edges as the script-built model.');

        // Project-scoped constants are one definition each; the lending facility keeps its own live knob.
        await window.click('#parametersButton');
        await window.waitForSelector('#parametersPanel:not([hidden])');
        assert.match(await window.textContent('#parametersSummary'), /· 15 shared$/, 'Nine shared parameters plus six per-pair credit shares.');

        await runToTarget();
        const [baseline] = await finalSamples();
        assertConserved(baseline, 'Bundle-wired baseline');
        for (const name of Object.keys(nodesOnly.states)) {
            assert.ok(Math.abs(stateValueBundled(baseline, name) - stateValue(reference.baseline, name)) < 1e-6,
                `${name}: bundle-wired model ${stateValueBundled(baseline, name)} vs script-built ${stateValue(reference.baseline, name)}`);
        }
        const lending = await forkWith(session, 0, { 'Emergency lending': 15 });
        assertConserved(lending, 'Bundle-wired lending fork');
        for (const name of Object.keys(nodesOnly.states)) {
            assert.ok(Math.abs(stateValueBundled(lending, name) - stateValue(reference.fork, name)) < 1e-6, `${name}: bundle-wired lending fork differs from the script-built one.`);
        }
        console.log('Bundle-wired model matches the script-built one: baseline and lending fork agree on every state.');
    });

    // --- Scenario 3: the DeFi liquidation cascade holds still without a shock, and cascades with one. -
    const defiStates = stateValueIn(defiModel.states);
    const defiTargetTime = 30;
    const vaultNames = ['Vault 1', 'Vault 2', 'Vault 3'];
    // ETH is conserved across the pool, arbitrageur, liquidator and vaults; USDC held minus
    // outstanding debt is conserved (repaid debt leaves both).
    const assertDefiConserved = (sample, label) => {
        const value = (name) => defiStates(sample, name);
        const eth = value('AMM pool.reserveX') + value('Arbitrageur.eth') + value('Liquidator.eth') + vaultNames.reduce((total, vault) => total + value(`${vault}.collateral`), 0);
        const usdc = value('AMM pool.reserveY') + value('Arbitrageur.usdc') + value('Liquidator.usdc') - vaultNames.reduce((total, vault) => total + value(`${vault}.debt`), 0);
        assert.ok(Math.abs(eth - 600) < 1e-6, `${label}: ETH was not conserved (${eth})`);
        assert.ok(Math.abs(usdc - 10230000) < 1e-3, `${label}: USDC minus debt was not conserved (${usdc})`);
    };
    const defi = await withApp(defiModel.path, async (session) => {
        const { finalSamples, runToTarget } = session;
        await runToTarget();
        const [baseline] = await finalSamples();
        assertDefiConserved(baseline, 'DeFi baseline');
        for (const vault of vaultNames) assert.equal(defiStates(baseline, `${vault}.collateral`), 100, `${vault} must be untouched while the price holds`);
        assert.ok(Math.abs(defiStates(baseline, 'AMM pool.reserveY') / defiStates(baseline, 'AMM pool.reserveX') - 2000) < 1e-6, 'The pool should sit at the reference price');

        // Shock: the outside price steps down 20% at day 5. The most leveraged vault is liquidated straight
        // away; its collateral sale pushes the thin pool below the outside price, which trips vault 2 too.
        const shock = await forkWith(session, 0, { 'Reference price': 1600 }, { day: 5, liveRows: 1 });
        assertDefiConserved(shock, 'DeFi shock');
        assert.ok(defiStates(shock, 'Vault 3.collateral') < 1, 'The most leveraged vault should be fully liquidated');
        assert.ok(defiStates(shock, 'Vault 3.debt') > 0, 'Its collateral should not cover its debt: the protocol is left with bad debt');
        assert.ok(defiStates(shock, 'Vault 2.debt') < 120000 - 1000, 'Vault 2 should be liquidated by the cascade although the outside price never reached its threshold');
        assert.equal(defiStates(shock, 'Vault 1.collateral'), 100, 'Vault 1 is safe enough to survive');
        console.log(`DeFi cascade after a 20% price shock: vault debts ${vaultNames.map((vault) => defiStates(shock, `${vault}.debt`).toFixed(0)).join(' / ')}, collateral ${vaultNames.map((vault) => defiStates(shock, `${vault}.collateral`).toFixed(1)).join(' / ')}.`);
        return { baseline, shock };
    }, { targetTime: defiTargetTime });

    // --- Scenario 4: the same DeFi model wired up from the component bundles behaves identically. ---
    const defiNodesOnly = await writeNodesOnlyModel('defiLiquidationCascade', join(scratch, 'defiNodesOnly.kjt'));
    await withApp(defiNodesOnly.path, async (session) => {
        const { window, finalSamples, runToTarget } = session;
        const value = stateValueIn(defiNodesOnly.states);
        const { applyBundle, edgeCount } = await bundleWiring(window, defiNodesOnly);
        await applyBundle('ammArbitrage', ['AMM pool', 'Arbitrageur'], 2);
        await applyBundle('liquidationSale', ['Liquidator', 'AMM pool'], 2);
        for (const vault of vaultNames) {
            await applyBundle('oracleFeed', ['AMM pool', vault], 1);
            await applyBundle('vaultLiquidation', [vault, 'Liquidator'], 3);
        }
        assert.equal(await edgeCount(), 2 + 2 + 3 * (1 + 3), 'The bundles should add the same 16 edges as the script-built model.');
        await window.click('#parametersButton');
        await window.waitForSelector('#parametersPanel:not([hidden])');
        assert.equal(await window.textContent('#parametersSummary'), '8 parameters · 8 shared');

        await runToTarget();
        const [baseline] = await finalSamples();
        for (const name of Object.keys(defiNodesOnly.states)) {
            assert.ok(Math.abs(value(baseline, name) - defiStates(defi.baseline, name)) < 1e-6, `${name}: bundle-wired DeFi baseline differs from the script-built one`);
        }
        const shock = await forkWith(session, 0, { 'Reference price': 1600 }, { day: 5, liveRows: 1 });
        for (const name of Object.keys(defiNodesOnly.states)) {
            assert.ok(Math.abs(value(shock, name) - defiStates(defi.shock, name)) < 1e-6, `${name}: bundle-wired DeFi shock differs from the script-built one`);
        }
        console.log('Bundle-wired DeFi model matches the script-built one: baseline and shock fork agree on every state.');
    }, { targetTime: defiTargetTime });

    // --- Scenario 5: the reference models are offered in Konjugate's Examples dialog. ----------------
    await withApp(nodesOnly.path, async ({ window }) => {
        await window.click('#exampleButton');
        await window.waitForSelector('#examplesExplorerDialog[open]');
        const labels = () => window.locator('.examplesExplorerItem b').allTextContents();
        await window.waitForFunction(() => [...document.querySelectorAll('.examplesExplorerItem b')].some((item) => item.textContent === 'Interbank liquidity run'), null, { timeout: 15000 });
        const listed = await labels();
        for (const name of ['Interbank liquidity run', 'DeFi liquidation cascade']) assert.ok(listed.includes(name), `The Examples dialog should offer ${name}`);
        await window.locator('.examplesExplorerItem', { hasText: 'Interbank liquidity run' }).click();
        await window.click('#examplesExplorerLoad');
        await window.waitForFunction(() => document.querySelector('.documentTitle').textContent === 'interbankLiquidityRun', null, { timeout: 15000 });
        // The example is the model the generator writes: six nodes and the same 55 edges.
        await window.waitForFunction(() => /6 nodes/.test(document.querySelector('.modelStatus').textContent) && /55 relationships/.test(document.querySelector('.modelStatus').textContent), null, { timeout: 15000 });
        console.log('Both reference models are offered in the Examples dialog, and the interbank model loads with its 55 edges.');
    });
    console.log('Fintech interaction checks passed.');
} finally {
    await rm(scratch, { recursive: true, force: true });
}
