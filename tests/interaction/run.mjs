/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Fintech-owned interaction harness: launches the sibling Konjugate app with a scratch userData
// containing the freshly built fintech packages, then checks they show up in the real UI, that the
// reference model runs and forks, and that the same model wired up from the plugin's component
// bundles behaves identically. Konjugate's own interaction runner cannot be extended from
// outside, so this drives the app through Playwright instead.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModels, writeNodesOnlyModel } from '../../scripts/buildModels.mjs';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { fintechRoot, konjugateDir } from '../../scripts/konjugatePaths.mjs';

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
        assert.match(await window.textContent('#parametersSummary'), /· 16 shared$/, 'Ten shared parameters (including the payment capacity) plus six per-pair credit shares.');

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

    // --- Scenario 6: the Start window: your data -> scenario -> comparison -> canvas -> export. -------
    const samplesDirectory = join(fintechRoot, 'packages', 'toolbox', 'samples');
    const badDirectory = join(scratch, 'bad');
    await mkdir(badDirectory, { recursive: true });
    const header = 'institution,cash_and_reserves,loans_and_securities,interbank_assets,deposits_and_other_liabilities,interbank_liabilities,equity\n';
    await writeFile(join(badDirectory, 'institutions.csv'), `${header}Alpha,10,80,0,90,0,5\nBeta,10,80,0,90,0,10\n`);
    const exportDirectory = join(scratch, 'export');
    await mkdir(exportDirectory, { recursive: true });
    await withApp(nodesOnly.path, async ({ app, window }) => {
        // Native file and folder dialogs cannot be driven, so the test answers them from a queue.
        await app.evaluate(({ dialog }) => {
            globalThis.fintechDialogAnswers = [];
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.fintechDialogAnswers.shift()] });
        });
        const answer = (path) => app.evaluate((_electron, value) => { globalThis.fintechDialogAnswers.push(value); }, path);

        await window.click('.addonTool[data-addon-id="konjugate.fintech.toolbox"][data-command-id="openFintechToolbox"]');
        // Other windows (an example guide, a welcome window) may open around it, so find the launcher by its page.
        let start;
        for (let attempt = 0; attempt < 150 && !start; attempt += 1) {
            start = app.windows().find((candidate) => candidate.url().includes('konjugate.fintech.toolbox'));
            if (!start) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(start, 'The Fintech toolbox window did not open.');
        const startLog = [];
        start.on('console', (message) => startLog.push(`${message.type()}: ${message.text().slice(0, 300)}`));
        start.on('pageerror', (error) => startLog.push(`pageerror: ${error.message.slice(0, 300)}`));
        await start.waitForLoadState('domcontentloaded');
        await start.click('[data-launch="start"]');
        await start.waitForSelector('#slots .slot', { timeout: 15000 }).catch((error) => { throw new Error(`${error.message}\nStart window log:\n${startLog.join('\n')}\nURL: ${start.url()}`); });
        await start.waitForSelector('.konjugateAddonIdentity > img', { timeout: 10000 });
        assert.equal(await start.locator('#slots .slot').count(), 2, 'The window offers an institutions slot and an exposures slot.');
        assert.equal(await start.locator('#checkData').isDisabled(), true, 'Nothing can be checked before a required file is chosen.');
        assert.equal(await start.locator('.step[data-step="scenario"]').isDisabled(), true);

        // A file with a balance-sheet problem is refused, and the message names the row.
        await answer(join(badDirectory, 'institutions.csv'));
        await start.click('[data-choose="institutions"]');
        await start.waitForSelector('#slots .file-line .name');
        await start.click('#checkData');
        await start.waitForSelector('#importResult .notice.error');
        const problems = await start.textContent('#importResult .notice.error');
        assert.match(problems, /institutions\.csv/);
        assert.match(problems, /line 2/);
        assert.match(problems, /Alpha: assets 90 do not equal liabilities and equity 95/);
        assert.equal(await start.locator('.step[data-step="scenario"]').isDisabled(), true, 'No model is built from a file with errors.');

        // A file as a European spreadsheet writes it: semicolons, thousands dots, decimal commas, a euro sign, and
        // a Windows-1252 encoding for the accented name. It imports, and the window says how it was read.
        const european = (await readFile(join(samplesDirectory, 'institutions.csv'), 'utf8')).trim().split('\n').map((line, index) => {
            if (index === 0) return line.replaceAll(',', ';').replace('cash_and_reserves', 'cash_and_reserves (EUR m)');
            const [name, ...numbers] = line.split(',');
            return [name === 'Alder Bank' ? 'Alder Banque Créditée' : name, ...numbers.map((value, column) => `${column === 0 ? '€ ' : ''}${Number(value).toLocaleString('de-DE')},0`)].join(';');
        }).join('\n');
        await writeFile(join(badDirectory, 'european.csv'), Buffer.from(`sep=;\n${european}\n`.replaceAll('€', '\u0080'), 'latin1'));
        await answer(join(badDirectory, 'european.csv'));
        await start.click('[data-choose="institutions"]');
        await start.click('#checkData');
        await start.waitForSelector('#importResult .notice.ok, #importResult .notice.error, #importStatus .notice.error');
        assert.equal(await start.locator('.notice.error').count(), 0, await start.locator('.notice.error').allTextContents().then((texts) => texts.join(' | ')));
        const notes = await start.textContent('#importResult .notice.warning');
        assert.match(notes, /separated by semicolons/);
        assert.match(notes, /decimal comma/);
        assert.match(notes, /windows-1252/);
        assert.match(await start.textContent('#importResult tbody'), /Alder Banque Créditée/, 'The accented name survives the Windows-1252 decoding.');

        // The real files import cleanly.
        await answer(join(samplesDirectory, 'institutions.csv'));
        await start.click('[data-choose="institutions"]');
        await answer(join(samplesDirectory, 'exposures.csv'));
        await start.click('[data-choose="exposures"]');
        await start.click('#checkData');
        await start.waitForSelector('#importResult .notice.ok');
        assert.match(await start.textContent('#importResult .notice.ok'), /8 institutions, 38 interbank exposures/);
        assert.equal(await start.locator('#importResult tbody tr').count(), 8);

        await start.click('#toScenarios');
        await start.waitForSelector('#scenarioList .scenario');
        // B2: the toolbox's manifest lists all eight scenarios (this tool's four, and Market Dynamics' four); this
        // tool must show only its own.
        assert.equal(await start.locator('#scenarioList .scenario').count(), 4, "Only this tool's own scenarios are listed, not Market Dynamics' too.");
        assert.deepEqual((await start.locator('#scenarioList .scenario').evaluateAll((nodes) => nodes.map((node) => node.dataset.scenario))).sort(),
            ['depositorRun', 'marketWideRun', 'runWithCentralBankSupport', 'runWithPriceShock']);
        // The same scoping keeps the Learn step to this tool's own three help pages, each with its own description.
        // Both views' #learnCards exist in the DOM at once (only the active view is hidden by CSS), so this must be
        // scoped to view-start specifically or it would count Market Dynamics' cards too.
        await start.click('#view-start .step[data-step="learn"]');
        assert.equal(await start.locator('#view-start #learnCards .card').count(), 3, "Only this tool's own help pages are listed.");
        assert.equal(await start.locator('#view-start #learnCards .card p:empty').count(), 0, 'Every listed page has its own description.');
        await start.click('#view-start .step[data-step="scenario"]');
        assert.equal(await start.inputValue('#entityChoice'), 'Alder Bank', 'The stressed institution defaults to the largest.');
        assert.match(await start.textContent('#scenarioDetail'), /withdraw 1\.5% of Alder Bank's deposits/);
        await start.click('#runScenario');
        await start.waitForSelector('#panel-results.active #tiles .tile', { timeout: 120000 });
        assert.match(await start.textContent('#title-results'), /Depositor run on Alder Bank/);
        const headline = await start.textContent('#headline');
        console.log(`Start window headline: ${headline}`);
        assert.match(headline, /institution/i);
        assert.equal(await start.locator('#resultTable tbody tr').count(), 8);
        assert.ok(await start.locator('#chart svg path').count() >= 10, 'The chart draws a baseline and a scenario line per institution shown.');
        // The stressed institution loses equity and is the hardest hit.
        assert.match(await start.textContent('#tiles'), /Alder Bank/);

        // B3: "Canvas Live Sync" claims every import and run builds the canvas model in the background,
        // without needing "Open in Konjugate to inspect" first. Confirm the main window already reflects
        // this run, before #openCanvas is ever clicked.
        await window.waitForFunction(() => /11 nodes/.test(document.querySelector('.modelStatus')?.textContent ?? ''), null, { timeout: 15000 });
        assert.equal(await window.locator('#branchChips > *').count(), 2, 'Canvas Live Sync should already show the baseline and this run\'s branch.');

        // Open in the canvas: the main window now holds the model with a baseline and a forked branch.
        await start.click('#openCanvas');
        await window.waitForFunction(() => document.querySelector('.documentTitle').textContent === 'FintechToolbox', null, { timeout: 30000 });
        await window.waitForFunction(() => document.querySelectorAll('#branchChips > *').length === 2, null, { timeout: 30000 });
        assert.match(await window.textContent('.modelStatus'), /11 nodes/);

        // Export: results, summary, the model with its results, and a manifest that lets it be reproduced.
        await answer(exportDirectory);
        await start.click('#exportResults');
        await start.waitForFunction(() => document.querySelector('#exportStatus').textContent.includes('Saved.'), null, { timeout: 30000 });
        const [folderName] = await readdir(exportDirectory);
        const folder = join(exportDirectory, folderName);
        assert.deepEqual((await readdir(folder)).sort(), ['project.kjt', 'results.csv', 'run-manifest.json', 'summary.csv']);
        const manifest = JSON.parse(await readFile(join(folder, 'run-manifest.json'), 'utf8'));
        const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
        assert.equal(manifest.package.addonId, 'konjugate.fintech.toolbox');
        assert.equal(manifest.scenario.name, 'Depositor run');
        assert.equal(manifest.scenario.chosenEntity, 'Alder Bank');
        assert.equal(manifest.inputs.find((input) => input.role === 'institutions').sha256, await digest(join(samplesDirectory, 'institutions.csv')), 'The manifest records the hash of the file that was read.');
        assert.equal(manifest.inputs.find((input) => input.role === 'exposures').sha256, await digest(join(samplesDirectory, 'exposures.csv')));
        for (const [name, entry] of Object.entries(manifest.files)) assert.equal(entry.sha256, await digest(join(folder, name)), `${name} matches its recorded hash`);
        const results = await readFile(join(folder, 'results.csv'), 'utf8');
        assert.match(results, /^branch,time,node,state,unit,value\n/);
        assert.ok(results.includes('Depositor run,') && results.includes('Baseline,'), 'The results file holds both branches.');
        // A bank cannot pay out more than it holds: no institution's reserves ever go below zero in any branch.
        const reserveValues = results.split('\n').filter((line) => /,Reserves,/i.test(line) && !line.includes('Central bank') && !line.includes('Depositor wallets')).map((line) => Number(line.split(',').at(-1)));
        assert.ok(reserveValues.length > 0 && Math.min(...reserveValues) > -1e-6, `Reserves stay at or above zero (lowest ${Math.min(...reserveValues)}).`);
        console.log(`Start window: import, scenario, comparison, canvas and export all work (${manifest.scenario.interventions.length} intervention applied to ${manifest.scenario.chosenEntity}).`);
    });

    // --- Scenario 6b: the settings on the Start window: change, refuse, mark, record, explore, pin. -----------
    const exportDirectory2 = join(scratch, 'export2');
    await mkdir(exportDirectory2, { recursive: true });
    await withApp(nodesOnly.path, async ({ app, window }) => {
        await app.evaluate(({ dialog }) => {
            globalThis.fintechDialogAnswers = [];
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.fintechDialogAnswers.shift()] });
        });
        const answer = (path) => app.evaluate((_electron, value) => { globalThis.fintechDialogAnswers.push(value); }, path);
        await window.click('.addonTool[data-addon-id="konjugate.fintech.toolbox"][data-command-id="openFintechToolbox"]');
        let start;
        for (let attempt = 0; attempt < 150 && !start; attempt += 1) {
            start = app.windows().find((candidate) => candidate.url().includes('konjugate.fintech.toolbox'));
            if (!start) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(start, 'The Fintech toolbox window did not open.');
        const pageErrors = [];
        start.on('pageerror', (error) => pageErrors.push(error.message));
        await start.click('[data-launch="start"]');
        await start.waitForSelector('#useSample');
        await start.click('#useSample');
        await start.waitForSelector('#importResult .notice.ok', { timeout: 60000 });
        await start.click('#toScenarios');
        await start.click('[data-scenario="runWithPriceShock"]');
        await start.waitForSelector('#entityChoice');

        // The panel is collapsed, every control starts at its default, and nothing is marked as changed.
        assert.equal(await start.locator('#controls').evaluate((element) => element.open), false, 'The settings panel is collapsed by default.');
        assert.equal(await start.textContent('#controlsBadge'), 'defaults');
        assert.equal(await start.locator('#resetAll').isDisabled(), true);
        await start.click('#controls > summary');
        assert.equal(await start.inputValue('#n-haircut'), '50');
        assert.equal(await start.inputValue('#n-a\\:reserveTargetShare'), '10');
        assert.equal(await start.locator('[data-marker="haircut"] button').count(), 0);
        assert.match(await start.textContent('#controlsBody'), /Cash \/ deposits/, 'Plain data ratios are shown beside each institution.');

        // A value the model cannot work with is refused with a reason, and blocks the run; one outside the advisory band is allowed with a note.
        await start.fill('#n-haircut', '150');
        await start.waitForSelector('#controlProblems .notice.error');
        assert.match(await start.textContent('#controlProblems'), /Forced-sale discount cannot be above 100%/);
        assert.equal(await start.locator('#view-start #runScenario').isDisabled(), true);
        await start.fill('#n-haircut', '85');
        assert.equal(await start.locator('#controlProblems .notice').count(), 0);
        assert.equal(await start.locator('#view-start #runScenario').isDisabled(), false, 'Outside the advisory band is advice, not a refusal.');
        assert.match(await start.textContent('[data-detail="haircut"]'), /Outside the range this model has been explored over/);

        // A changed value is marked with its default, and can be reset on its own.
        await start.fill('#n-haircut', '30');
        await start.waitForSelector('[data-marker="haircut"] button');
        assert.match(await start.textContent('[data-marker="haircut"]'), /changed from 50%/);
        assert.equal(await start.textContent('#controlsBadge'), '1 changed');

        // Run with it: the results say the run is custom, and the export records what was changed.
        await start.click('#runScenario');
        await start.waitForSelector('#panel-results.active #tiles .tile', { timeout: 120000 });
        assert.match(await start.textContent('#customSettings'), /Custom settings/);
        assert.match(await start.textContent('#customSettings'), /forced-sale discount/);
        assert.match(await start.textContent('#headline'), /1 of 8 institutions become insolvent/, 'A 30% discount makes Alder fail and nobody else.');
        await answer(exportDirectory2);
        await start.click('#exportResults');
        await start.waitForFunction(() => document.querySelector('#exportStatus').textContent.includes('Saved.'), null, { timeout: 30000 });
        const [folder] = await readdir(exportDirectory2);
        assert.ok((await readdir(join(exportDirectory2, folder))).includes('run-manifest.json'), `Export folder holds ${(await readdir(join(exportDirectory2, folder))).join(', ')}; status: ${await start.textContent('#exportStatus')}`);
        const manifest = JSON.parse(await readFile(join(exportDirectory2, folder, 'run-manifest.json'), 'utf8'));
        assert.deepEqual(manifest.overrides.baseHaircut, { '*': { value: 0.3 } }, 'The override is recorded in the run manifest.');
        assert.equal(manifest.importerOptions, undefined, 'No importer options were changed, so none are recorded.');
        assert.ok(manifest.scenario.interventions.some((change) => change.parameter === 'baseHaircut' && change.value === 0.3), 'The applied value is recorded too.');

        // An assumption rebuilds the model and is recorded as an importer option; halving the reserve target means nobody fails.
        await start.click('#anotherScenario');
        await start.fill('#n-a\\:reserveTargetShare', '5');
        await start.click('#resetAll').catch(() => {});
        await start.fill('#n-a\\:reserveTargetShare', '5');
        await start.fill('#n-haircut', '50');
        await start.click('#runScenario');
        await start.waitForFunction(() => /No institution becomes insolvent/.test(document.querySelector('#headline').textContent), null, { timeout: 120000 });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await answer(exportDirectory2);
        await start.click('#exportResults');
        // The status from the first export is still on the page, so wait for the second folder and its manifest to exist.
        let second;
        for (let attempt = 0; attempt < 300 && !second; attempt += 1) {
            const folders = (await readdir(exportDirectory2)).sort();
            const path = join(exportDirectory2, folders.at(-1), 'run-manifest.json');
            if (folders.length === 2 && existsSync(path)) second = JSON.parse(await readFile(path, 'utf8'));
            else await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(second, `The second export was written. Status: ${await start.textContent('#exportStatus')}; folders: ${(await readdir(exportDirectory2)).join(', ')}`);
        assert.deepEqual(second.importerOptions, { assumptions: { reserveTargetShare: 0.05 } }, 'The changed assumption is recorded as an importer option.');

        // Reset all returns to the declared scenario, and its result is exactly the one it always was.
        await start.click('#anotherScenario');
        await start.click('#resetAll');
        assert.equal(await start.textContent('#controlsBadge'), 'defaults');
        await start.click('#runScenario');
        await start.waitForFunction(() => /3 of 8 institutions become insolvent/.test(document.querySelector('#headline').textContent), null, { timeout: 120000 });
        assert.match(await start.textContent('#headline'), /Total equity falls by 49,339 million/);
        assert.equal((await start.textContent('#customSettings')).trim(), '', 'A default run says nothing about custom settings.');

        // Pin this run, run a milder one, and compare.
        await start.click('#pinRun');
        await start.click('#anotherScenario');
        await start.fill('#n-haircut', '30');
        await start.click('#runScenario');
        await start.waitForFunction(() => document.querySelector('#pinCompare').textContent.includes('Pinned') && /1 of 8/.test(document.querySelector('#headline').textContent), null, { timeout: 120000 });
        const pinText = await start.textContent('#pinCompare');
        assert.match(pinText, /3: [A-Za-z ,]*Alder Bank[A-Za-z ,]*Holly Bank|3: [A-Za-z ,]*Holly Bank[A-Za-z ,]*Alder Bank/);
        assert.match(pinText, /49,339/);
        assert.match(pinText, /24,833 \(−24,506\)/, 'The milder run is compared with the pinned one.');
        await start.click('#anotherScenario');
        await start.click('#resetAll');

        // Concurrent runs share one baseline and both succeed.
        const concurrent = await start.evaluate(async () => {
            const api = window.konjugateLauncher;
            const both = await Promise.all([1, 2].map((n) => api.runScenario('depositorRun', { entity: 'Alder Bank', signals: ['equity'], runTime: 40 + n * 0, retain: false })));
            return both.map((answer) => answer.ok);
        });
        assert.deepEqual(concurrent, [true, true]);

        // Explore: rank every institution; each row is the same shock on that institution, worst first.
        await start.click('.step[data-step="explore"]');
        await start.click('#runRank');
        await start.waitForSelector('#rankTable tbody tr', { timeout: 300000 });
        assert.equal(await start.locator('#rankTable tbody tr').count(), 8);
        const firstRow = (await start.locator('#rankTable tbody tr').first().textContent());
        assert.match(firstRow, /Alder Bank.*49,339/, 'Alder is the worst case, at the number a single run gives.');
        assert.match(await start.textContent('#explore-rank'), /does not say which institution is likely to be run on/);

        // Find the breaking point of the haircut for Alder, then confirm it stands.
        await start.click('[data-explore="breaking"]');
        await start.fill('#bpLow', '10');
        await start.click('#runBreaking');
        await start.waitForSelector('#bpHeadline', { timeout: 300000 });
        assert.match(await start.textContent('#bpHeadline'), /Alder Bank fails from a forced-sale discount of about 1[0-9]\.\d+%/);
        assert.match(await start.textContent('#explore-breaking'), /confirmed by running again just below/);

        // Which assumptions matter, with the fragility written out.
        await start.click('[data-explore="sensitivity"]');
        await start.click('#runSensitivity');
        await start.waitForSelector('#sensitivityBars', { timeout: 600000 });
        const bars = await start.textContent('#sensitivityBars');
        assert.match(bars, /Reserve target[\s\S]*Fragile\.[\s\S]*halving this: nobody fails/);

        // The four networks side by side.
        await start.click('[data-explore="networks"]');
        await start.click('#runNetworks');
        await start.waitForSelector('#networkTable tbody tr', { timeout: 300000 });
        assert.equal(await start.locator('#networkTable tbody tr').count(), 4);
        const networkText = await start.textContent('#networkTable');
        assert.match(networkText, /Interbank frozen/);
        assert.match(networkText, /No interbank exposure/);

        // Exploring puts everything back: the last run still opens in the canvas, and the window raised no errors.
        await start.click('.step[data-step="results"]');
        assert.match(await start.textContent('#headline'), /1 of 8/);
        assert.deepEqual(pageErrors, [], `The window raised no errors (${pageErrors.join(' | ')}).`);
        console.log('Start settings: refused, marked, recorded, reset, pinned, ranked, broken down, and compared across networks.');
    });

    // --- Scenario 7: the Markets window: series -> links -> model -> what-if -> canvas. --------------
    const shortDirectory = join(scratch, 'short');
    await mkdir(shortDirectory, { recursive: true });
    const shortFile = (name) => writeFile(join(shortDirectory, name), `Date,Close\n${Array.from({ length: 10 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')},${100 + index}`).join('\n')}\n`);
    await shortFile('One.csv');
    await shortFile('Two.csv');
    await withApp(nodesOnly.path, async ({ app, window }) => {
        await app.evaluate(({ dialog }) => {
            globalThis.fintechDialogAnswers = [];
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.fintechDialogAnswers.shift()] });
        });
        const answer = (path) => app.evaluate((_electron, value) => { globalThis.fintechDialogAnswers.push(value); }, path);
        await window.click('.addonTool[data-addon-id="konjugate.fintech.toolbox"][data-command-id="openFintechToolbox"]');
        let markets;
        for (let attempt = 0; attempt < 150 && !markets; attempt += 1) {
            markets = app.windows().find((candidate) => candidate.url().includes('konjugate.fintech.toolbox'));
            if (!markets) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(markets, 'The Fintech toolbox window did not open.');
        const marketsPageErrors = [];
        markets.on('pageerror', (error) => marketsPageErrors.push(error.message));
        await markets.click('[data-launch="markets"]');
        await markets.waitForSelector('.tab[data-tab="files"]');
        assert.equal(await markets.locator('#readData').isDisabled(), true, 'At least two series are needed before anything can be read.');
        await markets.click('.tab[data-tab="files"]');

        // Two files too short to compare are refused with a reason.
        await answer(join(shortDirectory, 'One.csv'));
        await markets.click('#addFiles');
        await markets.waitForSelector('#seriesSlot .file-line .name');
        await answer(join(shortDirectory, 'Two.csv'));
        await markets.click('#addFiles');
        await markets.waitForFunction(() => document.querySelectorAll('#seriesSlot .file-line .name').length === 2);
        await markets.click('#readData');
        await markets.waitForSelector('#importResult .notice.error');
        assert.match(await markets.textContent('#importResult .notice.error'), /at least 40/);

        // Fetching from the internet, with the network answered by the test: two symbols that exist and one that does not.
        const chart = (seed) => {
            let value = seed;
            const stamps = Array.from({ length: 130 }, (_, index) => 1767225600 + index * 86400);
            return JSON.stringify({ chart: { result: [{ meta: { gmtoffset: 0 }, timestamp: stamps, indicators: { adjclose: [{ adjclose: stamps.map((_, index) => (value *= 1 + 0.01 * Math.sin(index * seed))) }] } }], error: null } });
        };
        const search = JSON.stringify({ quotes: [{ symbol: 'AAA', shortname: 'Alpha Corp', quoteType: 'EQUITY', exchDisp: 'NASDAQ' }, { symbol: 'AAAF', shortname: 'Alpha Fund', quoteType: 'ETF', exchDisp: 'NYSEArca' }, { symbol: 'AAA=F', shortname: 'Alpha Futures', quoteType: 'FUTURE', exchDisp: 'CME' }, { symbol: 'AAAO', shortname: 'Alpha option', quoteType: 'OPTION', exchDisp: 'OPRA' }] });
        await app.evaluate((_electron, { bodies, searchBody }) => {
            globalThis.fetchedUrls = [];
            globalThis.fetch = async (url) => {
                globalThis.fetchedUrls.push(String(url));
                if (String(url).includes('/v1/finance/search')) return new Response(searchBody, { status: 200 });
                const symbol = decodeURIComponent(new URL(url).pathname.split('/').pop());
                if (bodies[symbol]) return new Response(bodies[symbol], { status: 200 });
                return new Response('not found', { status: 404 });
            };
        }, { bodies: { AAA: chart(3.1), BBB: chart(5.7) }, searchBody: search });
        while (await markets.locator('#seriesSlot [data-remove]').count()) {
            const before = await markets.locator('#seriesSlot [data-remove]').count();
            await markets.click('#seriesSlot [data-remove]');
            await markets.waitForFunction((count) => document.querySelectorAll('#seriesSlot [data-remove]').length < count, before);
        }

        // Search finds a name, offers the kinds it can be, and adds what is ticked to the selection.
        await markets.click('.tab[data-tab="search"]');
        await markets.fill('#searchBox', 'alpha');
        await markets.waitForSelector('#searchResults .result');
        assert.equal(await markets.locator('#searchResults .result').count(), 3, 'Options are not offered as series.');
        await markets.click('#searchTypes [data-type="EQUITY"]');
        assert.equal(await markets.locator('#searchResults .result').count(), 1, 'The kind filter narrows the results.');
        await markets.click('#searchResults [data-pick="AAA"]');
        assert.equal(await markets.textContent('#trayCount'), '1');

        // A group adds every member, and can be taken away again.
        await markets.click('.tab[data-tab="baskets"]');
        await markets.click('.basket >> nth=0 >> [data-basket-all]');
        assert.equal(await markets.textContent('#trayCount'), '12', 'One search pick and the eleven members of the first group.');
        await markets.click('.basket >> nth=0 >> [data-basket-all]');
        assert.equal(await markets.textContent('#trayCount'), '1');

        // A selection can be kept as a group of one's own, and taken away again.
        await markets.click('.tab[data-tab="search"]');
        await markets.fill('#searchBox', 'alpha');
        await markets.waitForSelector('#searchResults .result');
        await markets.click('#searchTypes [data-type="all"]');
        await markets.click('#searchResults [data-pick="AAAF"]');
        assert.equal(await markets.locator('#saveGroupRow').isVisible(), true, 'Two or more series can be saved as a group.');
        await markets.fill('#groupName', 'Alpha things');
        await markets.click('#saveGroup');
        await markets.click('.tab[data-tab="baskets"]');
        assert.equal(await markets.locator('.basket').count(), 10, 'The saved group joins the nine that ship.');
        assert.match(await markets.textContent('.basket >> nth=0 >> summary'), /Alpha things/);
        await markets.click('.basket >> nth=0 >> [data-basket-delete]');
        assert.equal(await markets.locator('.basket').count(), 9);
        await markets.click('.tab[data-tab="search"]');
        await markets.click('#searchResults [data-pick="AAAF"]');
        assert.equal(await markets.textContent('#trayCount'), '1');

        // Typed symbols join the selection; the range and bar size are the user's to set, and intraday limits are enforced.
        await markets.click('.tab[data-tab="symbols"]');
        await markets.fill('#symbolBox', 'BBB, NOPE');
        await markets.click('#addSymbols');
        assert.equal(await markets.textContent('#trayCount'), '3');
        await markets.selectOption('#fetchBars', '5m');
        assert.ok((await markets.inputValue('#fetchFrom')) >= new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10), 'Five-minute history is limited to the last 60 days.');
        await markets.selectOption('#fetchBars', '1d');
        await markets.click('#rangePresets [data-preset="365"]');
        assert.ok((await markets.inputValue('#fetchFrom')) <= new Date(Date.now() - 360 * 86400000).toISOString().slice(0, 10));
        await markets.click('#fetchNow');
        await markets.waitForSelector('#fetchStatus .notice.warning', { timeout: 30000 });
        assert.match(await markets.textContent('#fetchStatus .notice.warning'), /NOPE: query1\.finance\.yahoo\.com answered 404/);
        await markets.waitForFunction(() => document.querySelectorAll('#previewGrid .preview').length === 2, null, { timeout: 30000 });
        assert.equal(await markets.textContent('#trayCount'), '1', 'The failed symbol stays selected so it can be tried again.');
        await markets.click('.tab[data-tab="files"]');
        assert.deepEqual(await markets.locator('#seriesSlot .file-line .name').allTextContents(), ['Alpha Corp (AAA).csv (fetched)', 'BBB.csv (fetched)']);
        const requested = await app.evaluate(() => globalThis.fetchedUrls);
        assert.ok(requested.filter((url) => !url.includes('/v1/finance/search')).every((url) => url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/') && /period1=\d+&period2=\d+&interval=1d/.test(url)), 'Only the listed host is contacted, with the chosen range.');

        // Keeping it up to date: one series changes at the source, and a rebuild fetches it again and records the look.
        await markets.click('#toLinks');
        await markets.click('#findLinks');
        await markets.waitForSelector('#linkResult .notice', { timeout: 120000 });
        await markets.waitForSelector('#refreshCard #rebuildNow:not([disabled])');
        await app.evaluate((_electron, body) => {
            const original = globalThis.fetch;
            globalThis.fetch = async (url) => (String(url).includes('/AAA?') ? new Response(body, { status: 200 }) : original(url));
        }, chart(9.9));
        await markets.click('#rebuildNow');
        await markets.waitForFunction(() => /from 1 changed file/.test(document.querySelector('#refreshNote').textContent), null, { timeout: 120000 });
        assert.equal(await markets.locator('#refreshCard tbody tr').count(), 2, 'Each look is recorded, newest first.');
        // The step nav's "data" step exists in both views, so this must be scoped to view-markets or it would hit
        // view-start's hidden copy and hang.
        await markets.click('#view-markets .step[data-step="data"]');

        // B1: this tool's manifest also lists the balance-sheet importer, and it must reach for its own (market-series)
        // one, not whichever comes first. Taking the wrong one made "Use the sample series" import balance sheets and
        // then crash reading .length off the market-series-shaped data it never got. #useSample is also a shared id
        // between the two views, so this must be scoped too.
        await markets.click('#view-markets #useSample');
        await markets.waitForFunction(() => document.querySelectorAll('#previewGrid .preview').length === 7, null, { timeout: 30000 });
        assert.deepEqual(marketsPageErrors, [], `"Use the sample series" raised no error (${marketsPageErrors.join(' | ')}).`);
        assert.deepEqual((await markets.locator('#previewGrid .preview .n').allTextContents()).sort(),
            ['Airlines', 'Banks', 'Brent crude', 'Gold', 'Gold miners', 'S&P 500', 'US 10y yield'],
            "The market series' own sample names are shown, not balance-sheet institutions.");
        await markets.click('#toLinks');
        await markets.click('#findLinks');
        await markets.waitForSelector('#linkTable', { timeout: 120000 });
        console.log(`Markets links table: ${(await markets.locator('#linkResult').textContent()).replace(/\s+/g, ' ').slice(0, 900)}`);
        const linkRow = async (text) => markets.locator('#linkTable tbody tr', { hasText: text }).first();
        const miners = await linkRow('Gold → Gold miners');
        assert.match(await miners.textContent(), /moves with it/, 'Gold leads gold miners, with the same sign.');
        assert.equal(await miners.locator('input').isChecked(), true, 'A steady link is kept by default.');
        const airlines = await linkRow('Brent crude → Airlines');
        assert.match(await airlines.textContent(), /moves against it/, 'Crude leads airlines, with the opposite sign.');
        assert.ok(await markets.locator('#linkGraph svg path[marker-end]').count() >= 1, 'The kept links are drawn as a graph.');
        // A same-bar pair is one row, not two, with a way to use the other direction.
        const pairRowsText = await markets.locator('#togetherTable tbody tr td:nth-child(2)').allTextContents();
        const pairKeys = pairRowsText.map((text) => text.split(' → ').map((part) => part.trim()).sort().join('|'));
        assert.equal(new Set(pairKeys).size, pairKeys.length, `Each same-bar pair is listed once (${pairRowsText.join(', ')}).`);
        console.log(`Markets links: ${(await markets.locator('#linkTable tbody tr').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim()).slice(0, 4).join(' | ')}`);

        // Build the model and shock gold: the miners follow, the unrelated series stay put.
        await markets.click('#buildModel');
        await markets.waitForSelector('#buildStatus .notice.ok', { timeout: 60000 });
        await markets.click('#toWhatIf');
        // B2, the same check from the other side: this tool must show only its own four scenarios, not Interbank
        // Stress's four too.
        assert.equal(await markets.locator('#scenarioList .scenario').count(), 4, "Only this tool's own scenarios are listed, not Interbank Stress's too.");
        assert.deepEqual((await markets.locator('#scenarioList .scenario').evaluateAll((nodes) => nodes.map((node) => node.dataset.scenario))).sort(),
            ['fall', 'project', 'replay', 'rise']);
        // Both views' #learnCards exist in the DOM at once (only the active view is hidden by CSS), so this must be
        // scoped to view-markets specifically or it would count Interbank Stress's cards too.
        await markets.click('#view-markets .step[data-step="learn"]');
        assert.equal(await markets.locator('#view-markets #learnCards .card').count(), 3, "Only this tool's own help pages are listed.");
        assert.equal(await markets.locator('#view-markets #learnCards .card p:empty').count(), 0, 'Every listed page has its own description.');
        await markets.click('#view-markets .step[data-step="whatif"]');
        await markets.selectOption('#entityChoice', 'Gold');
        await markets.click('#view-markets #runScenario');
        await markets.waitForSelector('#panel-results.active #tiles .tile', { timeout: 120000 });
        const headline = await markets.textContent('#view-markets #headline');
        console.log(`Markets headline: ${headline}`);
        assert.match(headline, /Gold ends −/);
        assert.match(headline, /the biggest is Gold miners at −/);
        assert.equal(await markets.locator('#resultTable tbody tr').count(), 7);
        const tableRows = await markets.locator('#resultTable tbody tr').allTextContents();
        assert.match(tableRows.find((row) => row.startsWith('Banks')), /[+−]?0\.0\d%/, 'A series the shock does not reach barely moves.');
        assert.ok(await markets.locator('#chart svg path').count() >= 2, 'The chart draws a line for each series the shock reaches.');

        // B3, the same check from Market Dynamics' side: the main window already reflects this run, before
        // #openCanvas is ever clicked.
        await window.waitForFunction(() => /8 nodes/.test(document.querySelector('.modelStatus')?.textContent ?? ''), null, { timeout: 15000 });
        assert.equal(await window.locator('#branchChips > *').count(), 2, 'Canvas Live Sync should already show the baseline and this run\'s branch.');

        // #runScenario, #headline and #openCanvas are all shared ids between the two views, so each must be scoped
        // to view-markets specifically.
        await markets.click('#view-markets #openCanvas');
        await window.waitForFunction(() => document.querySelector('.documentTitle').textContent === 'FintechToolbox', null, { timeout: 30000 });
        await window.waitForFunction(() => document.querySelectorAll('#branchChips > *').length === 2, null, { timeout: 30000 });
        assert.match(await window.textContent('.modelStatus'), /8 nodes/);
        console.log('Markets window: read, links, model, what-if and canvas all work.');

        // Hold the last month back and replay what really happened: the model is compared with the actual outcome.
        // The "data" step is shared between the two views' step navs, so this must be scoped too.
        await markets.click('#view-markets .step[data-step="data"]');
        await markets.click('#rangeQuick [data-quick="hold1"]');
        assert.match(await markets.textContent('#rangeCard'), /held back/);
        await markets.click('#toLinks');
        await markets.click('#findLinks');
        await markets.waitForSelector('#linkTable', { timeout: 120000 });
        await markets.click('#buildModel');
        await markets.waitForSelector('#buildStatus .notice.ok', { timeout: 60000 });
        await markets.click('#toWhatIf');
        await markets.click('#scenarioList [data-scenario="replay"]');
        assert.equal(await markets.locator('[data-driver="Gold"]').isChecked(), true, 'A series with a kept link going out of it is replayed by default.');
        await markets.click('#view-markets #runScenario');
        await markets.waitForSelector('#panel-results.active #tiles .tile', { timeout: 120000 });
        const replayHeadline = await markets.textContent('#view-markets #headline');
        console.log(`Markets replay: ${replayHeadline}`);
        assert.match(replayHeadline, /With the real moves of .*Gold.* replayed for \d+ bars/);
        // #resultTable is a shared id; the bare (whole-element) reads below must be scoped, unlike the
        // "#resultTable tbody tr" locator counts above, which are safe because view-start's table stays empty.
        assert.match(await markets.textContent('#view-markets #resultTable'), /held to its real path/);
        assert.match(await markets.textContent('#view-markets #resultTable'), /Market guess/, 'A market guess is offered beside no change when a market series is present.');
        assert.ok(await markets.locator('#chart svg path[stroke-dasharray]').count() >= 1, 'What really happened is drawn dashed beside the model.');

        // A projection with the range that past volatility allows, compared with the bars held back.
        await markets.click('#view-markets #anotherScenario');
        await markets.click('#scenarioList [data-scenario="project"]');
        await markets.click('#view-markets #runScenario');
        await markets.waitForSelector('#panel-results.active #projectPick:not(.hidden)', { timeout: 120000 });
        const projectHeadline = await markets.textContent('#view-markets #headline');
        console.log(`Markets projection: ${projectHeadline}`);
        assert.match(projectHeadline, /series ended inside the 68% range/);
        assert.ok(await markets.locator('#chart svg path[fill-opacity]').count() >= 2, 'The 68% and 95% ranges are shaded.');
        await markets.selectOption('#projectSeries', 'Gold miners');
        assert.match(await markets.textContent('#view-markets #legend'), /Gold miners: the model/);
    });
    console.log('Fintech interaction checks passed.');
} finally {
    await rm(scratch, { recursive: true, force: true });
}
