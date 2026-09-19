/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import importData from '../../packages/start/importers/balanceSheet.mjs';
import { fintechRoot, konjugateDir, konjugateModule } from '../../scripts/konjugatePaths.mjs';

const { reconcileEquationBindings, validateEquationLatex } = await import(pathToFileURL(konjugateModule('src/equationModel.mjs')));
// The importer reads bundle definitions from its package; in tests they come from the plugin's components.
const helpers = {
    reconcileEquationBindings, validateEquationLatex,
    readPackageJson: async (path) => JSON.parse(await readFile(join(fintechRoot, 'packages', 'engine', 'components', path.replace(/^bundles\//, '')), 'utf8'))
};
const samples = join(fintechRoot, 'packages', 'start', 'samples');
const sample = async (name) => readFile(join(samples, name), 'utf8');
const run = (institutions, exposures) => importData({
    files: [{ role: 'institutions', name: 'institutions.csv', text: institutions }, ...(exposures === undefined ? [] : [{ role: 'exposures', name: 'exposures.csv', text: exposures }])],
    helpers
});

const header = 'institution,cash_and_reserves,loans_and_securities,interbank_assets,deposits_and_other_liabilities,interbank_liabilities,equity\n';

test('the sample data imports cleanly into a model with the expected shape', async () => {
    const result = await run(await sample('institutions.csv'), await sample('exposures.csv'));
    assert.equal(result.ok, true, JSON.stringify(result.report.errors));
    assert.deepEqual(result.report.errors, []);
    assert.equal(result.report.summary.institutions, 8);
    assert.equal(result.report.summary.exposures, 38);
    assert.equal(result.report.summary.exposuresEstimated, false);
    // Eight banks plus the depositor wallets, the central bank and the asset market.
    assert.equal(result.document.nodes.length, 11);
    const bank = result.document.nodes.find((node) => node.name === 'Alder Bank');
    const value = (symbol) => bank.states.find((state) => state.symbol === symbol).initialValue;
    assert.equal(value('reserves') + value('loans') + value('claims'), value('deposits') + value('equity') + value('borrowing'), 'The imported balance sheet must balance.');
    assert.ok(result.parameterIndex.some((entry) => entry.key === 'withdrawalRate' && entry.entity === 'Alder Bank' && entry.live));
    assert.ok(result.parameterIndex.some((entry) => entry.key === 'baseHaircut' && entry.scope === 'global' && entry.live));
});

test('the same input always gives the same model', async () => {
    const [institutions, exposures] = [await sample('institutions.csv'), await sample('exposures.csv')];
    const first = await run(institutions, exposures);
    const second = await run(institutions, exposures);
    assert.equal(JSON.stringify(first.document), JSON.stringify(second.document));
});

test('problems are reported against the row that caused them', async () => {
    const cases = [
        [`${header}Alpha,10,80,10,90,5,5\nBeta,10,80,10,88,5,10\n`, undefined, /Beta: assets 100 do not equal liabilities and equity 103/],
        [`${header}Alpha,10,80,0,90,0,0\nAlpha,10,80,0,90,0,0\n`, undefined, /"Alpha" appears more than once \(first on line 2\)/],
        [`${header}Alpha,ten,80,0,90,0,0\nBeta,10,80,0,90,0,0\n`, undefined, /"ten" in cash_and_reserves is not a number/],
        [`${header}Alpha,-1,80,0,90,0,0\nBeta,10,80,0,90,0,0\n`, undefined, /cash_and_reserves is negative/],
        ['institution,cash_and_reserves\nAlpha,10\nBeta,10\n', undefined, /The column "loans_and_securities" is missing/],
        [`${header}Alpha,10,80,0,90,0,0\n`, undefined, /At least two institutions/]
    ];
    for (const [text, exposures, pattern] of cases) {
        const result = await run(text, exposures);
        assert.equal(result.ok, false, `expected a failure for ${text.slice(0, 60)}`);
        assert.ok(result.report.errors.some((error) => pattern.test(error.message)), `${pattern} not in ${JSON.stringify(result.report.errors)}`);
        assert.equal(result.document, undefined, 'A failed import must not produce a model.');
    }
    const imbalanced = await run(`${header}Alpha,10,80,0,90,0,3\nBeta,10,80,0,90,0,0\n`);
    assert.equal(imbalanced.report.errors[0].line, 2, 'The error names the spreadsheet row.');
    assert.equal(imbalanced.report.errors[0].column, 'balance sheet');
});

test('every problem in a file is reported in one pass', async () => {
    const result = await run(`${header}Alpha,10,80,0,90,0,7\nAlpha,10,80,0,90,0,5\nBeta,ten,80,0,90,0,5\nGamma,10,80,0,90,0,5\n`);
    assert.equal(result.ok, false);
    const messages = result.report.errors.map((error) => `${error.line}: ${error.message}`);
    assert.ok(messages.some((message) => /^3: "Alpha" appears more than once/.test(message)), messages.join('\n'));
    assert.ok(messages.some((message) => /^4: Beta: "ten" in cash_and_reserves is not a number/.test(message)), messages.join('\n'));
    assert.ok(messages.some((message) => /^2: Alpha: assets 90 do not equal liabilities and equity 97/.test(message)), 'the imbalance is reported alongside the other problems');
});

test('exposures are checked against the institutions and against each institution\'s totals', async () => {
    const institutions = `${header}Alpha,10,70,20,90,0,10\nBeta,10,110,0,90,20,10\n`;
    assert.equal((await run(institutions, 'lender,borrower,amount\nAlpha,Beta,20\n')).ok, true);
    const cases = [
        ['lender,borrower,amount\nAlpha,Gamma,20\n', /"Gamma" is not in the institutions file/],
        ['lender,borrower,amount\nAlpha,Alpha,20\n', /cannot lend to itself/],
        ['lender,borrower,amount\nAlpha,Beta,0\n', /more than zero/],
        ['lender,borrower,amount\nAlpha,Beta,25\n', /interbank_assets is 20 but exposures\.csv shows lending 25/]
    ];
    for (const [text, pattern] of cases) {
        const result = await run(institutions, text);
        assert.equal(result.ok, false);
        assert.ok(result.report.errors.some((error) => pattern.test(error.message)), `${pattern} not in ${JSON.stringify(result.report.errors)}`);
    }
});

test('with no exposures file, bilateral exposures are estimated from the totals and the user is told', async () => {
    const result = await run(await sample('institutions.csv'));
    assert.equal(result.ok, true, JSON.stringify(result.report.errors));
    assert.equal(result.report.summary.exposuresEstimated, true);
    assert.ok(result.report.warnings.some((warning) => /estimated/.test(warning.message)));
    // Interbank default edges exist along the estimated links, with credit shares that sum to one per borrower.
    const shares = new Map();
    for (const shared of result.document.sharedParameters.filter((parameter) => parameter.symbol.startsWith('creditShare'))) {
        const borrower = shared.name.match(/in (.+)\)$/)[1];
        shares.set(borrower, (shares.get(borrower) ?? 0) + shared.value);
    }
    for (const [borrower, total] of shares) assert.ok(Math.abs(total - 1) < 1e-3, `${borrower}: credit shares sum to ${total}`);
});

test('blank equity is computed as the balancing figure, and an insolvent balancing figure is an error', async () => {
    const computed = await run(`${header}Alpha,10,80,0,80,0,\nBeta,10,80,0,80,0,\n`);
    assert.equal(computed.ok, true);
    assert.ok(computed.report.warnings.some((warning) => /equity was blank/.test(warning.message)));
    const insolvent = await run(`${header}Alpha,10,80,0,95,0,\nBeta,10,80,0,80,0,\n`);
    assert.equal(insolvent.ok, false);
    assert.match(insolvent.report.errors[0].message, /already be insolvent/);
});

// The imported model must be accepted by the real engine and behave: run it for 60 days with and
// without a depositor run on the largest institution and check money and balance sheets are conserved.
const enginePath = join(konjugateDir, 'out', 'engine', 'konjugateEngine');
test('the sample model validates, runs, conserves money, and a run on one bank spreads stress', { skip: !existsSync(enginePath) && 'the Konjugate engine is not built' }, async () => {
    const { runWithEngine, validateWithEngine } = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
    const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };
    const result = await run(await sample('institutions.csv'), await sample('exposures.csv'));
    const validation = await validateWithEngine(JSON.stringify(result.document), engineOptions);
    assert.equal(validation.report.valid, true, JSON.stringify(validation.report.issues?.slice(0, 3)));
    const stateId = (nodeName, symbol) => result.document.nodes.find((node) => node.name === nodeName).states.find((state) => state.symbol === symbol).id;
    const finalValue = (run, nodeName, symbol) => run.result.samples.at(-1).states.find((state) => state.stateId === stateId(nodeName, symbol)).value;
    const baseline = await runWithEngine(JSON.stringify(result.document), { name: 'Baseline', targetTime: 60, globalTimeStep: 0.1, outputInterval: 0.5 }, engineOptions);
    // No shock, no change: every equity is where it started.
    for (const bank of result.report.institutions) assert.ok(Math.abs(finalValue(baseline, bank.name, 'equity') - bank.equity) < 1e-6, `${bank.name} moved with no shock`);
    // Run on the largest bank from day 0 by setting its withdrawal rate in the document.
    const stressed = structuredClone(result.document);
    const entry = result.parameterIndex.find((item) => item.key === 'withdrawalRate' && item.entity === 'Alder Bank');
    stressed.sharedParameters.find((shared) => shared.id === entry.sharedParameterId).value = 0.02;
    const shocked = await runWithEngine(JSON.stringify(stressed), { name: 'Run', targetTime: 60, globalTimeStep: 0.1, outputInterval: 0.5 }, engineOptions);
    const equityLoss = (bank) => result.report.institutions.find((item) => item.name === bank).equity - finalValue(shocked, bank, 'equity');
    assert.ok(equityLoss('Alder Bank') > 0, 'The bank under run should lose equity');
    assert.ok(result.report.institutions.some((item) => item.name !== 'Alder Bank' && equityLoss(item.name) > 1), 'Stress should spread to at least one other institution');
    // Each balance sheet still balances at the end of the run.
    for (const bank of result.report.institutions) {
        const value = (symbol) => finalValue(shocked, bank.name, symbol);
        assert.ok(Math.abs(value('reserves') + value('loans') + value('claims') - value('deposits') - value('equity') - value('borrowing')) < 1e-3 * bank.assets, `${bank.name} balance sheet is off`);
    }
});

test('files written by a European spreadsheet import: semicolons, decimal commas, currency symbols, unit notes and sep= lines', async () => {
    const semicolon = 'sep=;\ninstitution;cash_and_reserves (EUR m);loans_and_securities;interbank_assets;deposits_and_other_liabilities;interbank_liabilities;equity\n'
        + 'Alpha;"€ 10,5";80;0;"80,5";0;10\nBeta;10;"1.080,5";0;"1.080";0;"10,5"\n';
    const result = await run(semicolon);
    assert.equal(result.ok, true, JSON.stringify(result.report.errors));
    const alpha = result.document.nodes.find((node) => node.name === 'Alpha');
    assert.equal(alpha.states.find((state) => state.symbol === 'reserves').initialValue, 10.5);
    assert.equal(result.document.nodes.find((node) => node.name === 'Beta').states.find((state) => state.symbol === 'loans').initialValue, 1080.5);
    assert.ok(result.report.warnings.some((warning) => /separated by semicolons/.test(warning.message)));
    assert.ok(result.report.warnings.some((warning) => /decimal comma/.test(warning.message)));
    // Line numbers still match what the spreadsheet shows, even with the sep= line above the header.
    const broken = await run(semicolon.replace('Alpha;"€ 10,5"', 'Alpha;"€ ten"'));
    assert.equal(broken.report.errors[0].line, 3);
});

test('tab-separated files, quoted names and accounting negatives are understood', async () => {
    const tabs = `${header.replaceAll(',', '\t')}"Alpha, Inc"\t10\t80\t0\t80\t0\t10\nBeta\t10\t80\t0\t80\t0\t10\n`;
    const result = await run(tabs);
    assert.equal(result.ok, true, JSON.stringify(result.report.errors));
    assert.ok(result.document.nodes.some((node) => node.name === 'Alpha, Inc'));
    const negative = await run(`${header}Alpha,10,80,0,80,0,(5)\nBeta,10,80,0,80,0,10\n`);
    assert.match(negative.report.errors[0].message, /equity is negative/);
});

test('a non-UTF-8 file is flagged so accented names can be checked', async () => {
    const result = await importData({
        files: [{ role: 'institutions', name: 'institutions.csv', encoding: 'windows-1252', text: `${header}Crédit A,10,80,0,80,0,10\nBanque B,10,80,0,80,0,10\n` }], helpers
    });
    assert.equal(result.ok, true);
    assert.ok(result.report.warnings.some((warning) => /windows-1252/.test(warning.message)));
});

test('an institution with no deposits or no cash is refused with a message that says why, not left to fail in the engine', async () => {
    const zeroDeposits = await run(`${header}Alpha,10,80,0,0,0,90\nBeta,10,80,0,90,0,0\n`);
    assert.equal(zeroDeposits.ok, false);
    assert.match(zeroDeposits.report.errors[0].message, /Alpha: deposits_and_other_liabilities is zero. Depositors cannot run/);
    assert.equal(zeroDeposits.report.errors[0].line, 2);
    const zeroCash = await run(`${header}Alpha,0,80,0,80,0,0\nBeta,10,80,0,90,0,0\n`);
    assert.equal(zeroCash.ok, false);
    assert.match(zeroCash.report.errors[0].message, /Alpha: cash_and_reserves is zero/);
});

test('a run cannot pay out more than a bank holds, and support tapers instead of running on', async () => {
    const result = await run(await sample('institutions.csv'), await sample('exposures.csv'));
    const bank = result.document.edges.filter((edge) => edge.name.startsWith('Withdrawals'));
    assert.ok(bank.every((edge) => /\\min/.test(edge.equation) && /paymentCapacity/.test(edge.equation)), 'Each withdrawal edge is limited by payment capacity times current reserves.');
    const lending = result.document.edges.filter((edge) => edge.name.startsWith('Emergency lending'));
    assert.ok(lending.length > 0 && lending.every((edge) => /reserveTarget/.test(edge.equation)), 'Emergency lending depends on the shortfall against the reserve target.');
});
