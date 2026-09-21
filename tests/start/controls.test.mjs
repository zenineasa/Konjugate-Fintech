/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import importData from '../../packages/toolbox/importers/balanceSheet.mjs';
import { assumptionControls, assumptionDefaults, checkValue, networkOptions, readOptions, shockControls } from '../../packages/toolbox/lib/scenarioControls.mjs';
import { assumptionSensitivity, findBreakingPoint, fragilityText, rankInstitutions, summarizeRun } from '../../packages/toolbox/lib/explore.mjs';
import { buildRequest, checkControls, defaultControls } from '../../packages/toolbox/lib/scenarioRequest.mjs';
import { fintechRoot, konjugateModule } from '../../scripts/konjugatePaths.mjs';

const { reconcileEquationBindings, validateEquationLatex } = await import(pathToFileURL(konjugateModule('src/equationModel.mjs')));
const packageRoot = join(fintechRoot, 'packages', 'toolbox');
const helpers = { reconcileEquationBindings, validateEquationLatex, readPackageJson: async (path) => JSON.parse(await readFile(join(fintechRoot, 'packages', 'engine', 'components', path.replace(/^bundles\//, '')), 'utf8')) };
const sample = (name) => readFile(join(packageRoot, 'samples', name), 'utf8');
const build = async (options, exposures = true) => importData({
    files: [{ role: 'institutions', name: 'institutions.csv', text: await sample('institutions.csv') }, ...(exposures ? [{ role: 'exposures', name: 'exposures.csv', text: await sample('exposures.csv') }] : [])],
    helpers, options
});
const manifest = JSON.parse(await readFile(join(packageRoot, 'addon.json'), 'utf8'));
const scenario = (id) => manifest.contributes.scenarios.find((item) => item.scenarioId === id);
const summaryOf = (interventions) => interventions.map(({ parameter, target, value, fractionOfMaximum, at, duration }) => ({ parameter, target, value: value ?? null, fractionOfMaximum: fractionOfMaximum ?? null, at: at ?? 0, duration: duration ?? 0 }));
const declared = (id) => ({ ...scenario(id), interventions: summaryOf(scenario(id).interventions) });

test('the defaults of the assumptions are the values the model has always used', async () => {
    const bundle = async (name) => JSON.parse(await readFile(join(fintechRoot, 'packages', 'engine', 'components', `${name}.json`), 'utf8'));
    const shared = async (name, key) => (await bundle(name)).sharedParameters.find((parameter) => parameter.key === key).value;
    assert.equal(assumptionDefaults.fireSaleRate, await shared('fireSale', 'fireSaleRate'));
    assert.equal(assumptionDefaults.panicSensitivity, await shared('depositRun', 'panicSensitivity'));
    assert.equal(assumptionDefaults.flowRate, await shared('interbankLendingScaled', 'flowRate'));
    assert.equal(assumptionDefaults.writeDownRate, await shared('interbankDefault', 'writeDownRate'));
    assert.equal(assumptionDefaults.reserveTargetShare, 0.1);
    assert.equal(assumptionDefaults.centralBankShare, 0.25);
    assert.equal(assumptionDefaults.facilityShare, 0.1);
});

test('every control has a default inside its advisory band and its band inside its hard limit', () => {
    for (const control of [...assumptionControls, ...Object.values(shockControls)]) {
        assert.ok(control.advisoryMin >= control.hardMin && (control.hardMax === null || control.advisoryMax <= control.hardMax), `${control.key}: the advisory band is inside the hard limit`);
    }
    for (const control of assumptionControls) assert.ok(control.default >= control.advisoryMin && control.default <= control.advisoryMax, `${control.key}: the default is inside its own advisory band`);
});

test('a value outside a hard limit is refused with a reason, and one outside the advisory band is allowed with a note', () => {
    const reserve = assumptionControls.find((control) => control.key === 'reserveTargetShare');
    assert.equal(checkValue(reserve, 0).ok, false);
    assert.match(checkValue(reserve, 0).message, /cannot be below 0\.1%/);
    assert.match(checkValue(reserve, 1.2).message, /cannot be above 100%/);
    assert.match(checkValue(reserve, Number.NaN).message, /must be a number/);
    assert.match(checkValue(reserve, '0.1').message, /must be a number/);
    assert.deepEqual(checkValue(reserve, 0.1), { ok: true, advisory: null });
    assert.deepEqual(checkValue(reserve, 0.02), { ok: true, advisory: 'below' });
    assert.deepEqual(checkValue(reserve, 0.6), { ok: true, advisory: 'above' });
    assert.equal(checkValue(shockControls.haircut, 1).ok, true, '100% is allowed: sales fetch nothing.');
    assert.equal(checkValue(shockControls.haircut, 1.01).ok, false);
});

test('the importer refuses settings outside a hard limit, unknown settings and unknown network options, and names each problem', async () => {
    assert.deepEqual(readOptions({}).problems, []);
    const result = await build({ assumptions: { reserveTargetShare: 0, nonsense: 1, fireSaleRate: 2 }, network: 'somewhere' });
    assert.equal(result.ok, false);
    const messages = result.report.errors.map((error) => error.message).join(' | ');
    assert.match(messages, /Reserve target cannot be below 0\.1%/);
    assert.match(messages, /"nonsense" is not a setting/);
    assert.match(messages, /Forced-sale speed cannot be above 100%/);
    assert.match(messages, /"somewhere" is not one of the ways/);
});

test('with default options, or the defaults written out, the importer builds exactly the same model', async () => {
    const plain = await build({});
    const written = await build({ assumptions: assumptionDefaults, network: 'auto' });
    assert.equal(plain.ok, true);
    assert.equal(JSON.stringify(written.document), JSON.stringify(plain.document));
    assert.equal(JSON.stringify((await build(undefined)).document), JSON.stringify(plain.document));
    assert.deepEqual(plain.report.changed, []);
});

test('changed settings reach the model and are reported as changed; the rest are untouched', async () => {
    const plain = await build({});
    const changed = await build({ assumptions: { fireSaleRate: 0.03, panicSensitivity: 6, marketDepthShare: 0.5 } });
    assert.deepEqual(changed.report.changed.sort(), ['fireSaleRate', 'marketDepthShare', 'panicSensitivity']);
    const value = (result, symbol) => result.document.sharedParameters.find((parameter) => parameter.symbol === symbol).value;
    assert.equal(value(changed, 'fireSaleRate'), 0.03);
    assert.equal(value(changed, 'panicSensitivity'), 6);
    assert.equal(value(changed, 'flowRate'), value(plain, 'flowRate'));
    assert.ok(value(changed, 'priceImpact') > value(plain, 'priceImpact'), 'A shallower market moves prices more.');
    const edgeValue = (result) => result.document.edges.find((edge) => edge.name.startsWith('Fire sale (loans)')).parameters.find((parameter) => parameter.symbol === 'fireSaleRate').value;
    assert.equal(edgeValue(changed), 0.03, 'The copy on each edge follows the shared parameter.');
});

test('the four network options build what they say, and every balance sheet still balances', async () => {
    const balances = (result) => result.document.nodes.filter((node) => node.states.some((state) => state.symbol === 'equity')).map((node) => {
        const v = (symbol) => node.states.find((state) => state.symbol === symbol).initialValue;
        return { name: node.name, gap: v('reserves') + v('loans') + v('claims') - v('deposits') - v('equity') - v('borrowing'), claims: v('claims'), borrowing: v('borrowing'), reserves: v('reserves'), equity: v('equity') };
    });
    const linkEdges = (result) => result.document.edges.filter((edge) => /^(Interbank|Default)/.test(edge.name)).length;
    const auto = await build({ network: 'auto' });
    assert.ok(linkEdges(auto) > 0);
    const frozen = await build({ network: 'frozen' });
    assert.equal(linkEdges(frozen), 0, 'Frozen builds no lending and no defaults.');
    assert.deepEqual(balances(frozen).map((row) => [row.claims, row.borrowing]), balances(auto).map((row) => [row.claims, row.borrowing]), 'Frozen keeps every claim and borrowing at book value.');
    const none = await build({ network: 'none' });
    assert.equal(linkEdges(none), 0);
    assert.ok(balances(none).every((row) => row.claims === 0 && row.borrowing === 0), 'No interbank exposure removes the balances.');
    assert.ok(balances(none).every((row) => Math.abs(row.gap) < 1e-6), 'Every balance sheet still balances.');
    const before = balances(auto);
    balances(none).forEach((row, index) => {
        assert.equal(row.equity, before[index].equity, `${row.name}'s equity is unchanged.`);
        assert.ok(Math.abs(row.reserves - (before[index].reserves + before[index].claims - before[index].borrowing)) < 1e-6, `${row.name} settled its net position in cash.`);
    });
    const estimated = await build({ network: 'estimated' });
    assert.equal(estimated.report.summary.exposuresEstimated, true);
    assert.notEqual(JSON.stringify(estimated.document.edges.map((edge) => edge.name)), JSON.stringify(auto.document.edges.map((edge) => edge.name)), 'Setting the given exposures aside gives a different network.');
});

test('"no interbank exposure" is refused where an institution could not settle its net borrowing in cash', async () => {
    const text = 'institution,cash_and_reserves,loans_and_securities,interbank_assets,deposits_and_other_liabilities,interbank_liabilities,equity\nAlpha,10,140,0,80,50,20\nBeta,100,60,50,100,0,110\n';
    const result = await importData({ files: [{ role: 'institutions', name: 'institutions.csv', text }], helpers, options: { network: 'none' } });
    assert.equal(result.ok, false);
    assert.match(result.report.errors[0].message, /Alpha: settling its net interbank borrowing of 50 would need more cash than it holds \(10\)/);
    assert.equal((await importData({ files: [{ role: 'institutions', name: 'institutions.csv', text }], helpers, options: {} })).ok, true, 'The same data builds when the network is left as given.');
    assert.ok(networkOptions.some((option) => option.key === 'none'));
});

test('with every control at its default, a scenario asks for no change at all', () => {
    for (const id of ['depositorRun', 'runWithPriceShock', 'runWithCentralBankSupport', 'marketWideRun']) {
        const item = declared(id);
        const names = ['Alder Bank', 'Birch Bank', 'Cedar Bank'];
        const defaults = defaultControls(item, { entity: 'Alder Bank', names });
        const request = buildRequest(item, structuredClone(defaults), defaults, []);
        assert.deepEqual(request, { overrides: null, runTime: null, changed: [] }, id);
        assert.deepEqual(checkControls(item, defaults).problems, [], `${id}: the defaults are valid`);
    }
    const run = declared('depositorRun');
    const defaults = defaultControls(run, { entity: 'Alder Bank', names: ['Alder Bank'] });
    assert.deepEqual(defaults.stressed, { 'Alder Bank': 0.015 });
    assert.equal(defaults.duration, 8);
    assert.equal(defaults.haircut, 0.1, 'A scenario that declares no haircut leaves the model\'s own.');
    assert.equal(declared('runWithPriceShock') && defaultControls(declared('runWithPriceShock'), { entity: 'Alder Bank' }).haircut, 0.5);
    assert.deepEqual(Object.keys(defaultControls(declared('marketWideRun'), { names: ['A', 'B', 'C'] }).stressed), ['A', 'B', 'C']);
});

test('a changed control becomes exactly the change it names, and is listed as changed', () => {
    const item = declared('runWithCentralBankSupport');
    const index = [{ key: 'emergencyLending', entity: 'Alder Bank', maximum: 20000 }, { key: 'emergencyLending', entity: 'Birch Bank', maximum: 10000 }];
    const defaults = defaultControls(item, { entity: 'Alder Bank', names: ['Alder Bank', 'Birch Bank'] });
    const changed = structuredClone(defaults);
    changed.haircut = 0.3;
    changed.stressed['Alder Bank'] = 0.02;
    changed.stressed['Birch Bank'] = 0.01;
    changed.support.size = 0.25;
    changed.runLength = 90;
    const request = buildRequest(item, changed, defaults, index);
    assert.deepEqual(request.overrides.baseHaircut, { '*': { value: 0.3 } });
    assert.deepEqual(request.overrides.withdrawalRate, { 'Alder Bank': { value: 0.02, at: 0, duration: 8 }, 'Birch Bank': { value: 0.01, at: 0, duration: 8 } });
    assert.deepEqual(request.overrides.emergencyLending, { 'Alder Bank': { value: 5000, at: 3, duration: 0 }, 'Birch Bank': { value: 2500, at: 3, duration: 0 } });
    assert.equal(request.runTime, 90);
    assert.ok(request.changed.includes('forced-sale discount') && request.changed.includes('length of the simulation'));
    const stopped = structuredClone(defaults);
    stopped.support.on = false;
    assert.deepEqual(buildRequest(item, stopped, defaults, index).overrides, { emergencyLending: { 'Alder Bank': null } });
    const noRun = structuredClone(defaults);
    delete noRun.stressed['Alder Bank'];
    assert.deepEqual(buildRequest(item, noRun, defaults, index).overrides.withdrawalRate, { 'Alder Bank': null });
});

test('the controls are checked against their hard limits, and advice is given outside the advisory band without stopping anything', () => {
    const item = declared('depositorRun');
    const defaults = defaultControls(item, { entity: 'Alder Bank', names: ['Alder Bank'] });
    const bad = structuredClone(defaults);
    bad.stressed['Alder Bank'] = 1.5;
    bad.haircut = -0.1;
    bad.duration = 100;
    const { problems } = checkControls(item, bad);
    assert.ok(checkControls(item, { ...bad, runLength: 200 }).problems.some((line) => /Length of the simulation cannot be above 120/.test(line)));
    assert.ok(problems.some((line) => /Withdrawal rate for Alder Bank cannot be above 100%/.test(line)));
    assert.ok(problems.some((line) => /Forced-sale discount cannot be below 0%/.test(line)));
    assert.ok(problems.some((line) => /Duration cannot be above/.test(line)));
    const unusual = structuredClone(defaults);
    unusual.stressed['Alder Bank'] = 0.08;
    const result = checkControls(item, unusual);
    assert.deepEqual(result.problems, []);
    assert.equal(result.advice['Withdrawal rate for Alder Bank'], 'above');
});

// ---- the multi-run views, with a stand-in for a run -------------------------------------------------------

const fake = (failures, total) => ({ failures: failures.map(([name, day]) => ({ name, day })), total, rows: [] });

test('ranking runs every institution once, whatever the concurrency, and orders them by damage, then failures', async () => {
    const results = { A: fake([['A', 10]], 50), B: fake([['B', 12], ['C', 30]], 50), C: fake([], 10), D: fake([['D', 5]], 90) };
    const calls = [];
    const order = async (concurrency) => (await rankInstitutions({ names: ['A', 'B', 'C', 'D'], concurrency, run: async (name) => { calls.push(name); await new Promise((resolve) => setTimeout(resolve, name === 'A' ? 20 : 1)); return results[name]; } })).map((row) => row.name);
    assert.deepEqual(await order(1), ['D', 'B', 'A', 'C']);
    assert.deepEqual(await order(3), ['D', 'B', 'A', 'C']);
    assert.equal(calls.length, 8);
    const rows = await rankInstitutions({ names: ['B'], run: async () => results.B });
    assert.deepEqual(rows[0], { name: 'B', total: 50, failures: 2, failed: ['B', 'C'], firstFailureDay: 12, ownFailureDay: 12 });
    let stop = false;
    const partial = await rankInstitutions({ names: ['A', 'B', 'C', 'D'], concurrency: 1, cancelled: () => stop, run: async (name) => { if (name === 'B') stop = true; return results[name]; } });
    assert.equal(partial.length, 2, 'Cancelling stops the queue and keeps what finished.');
});

test('the breaking point is found, narrowed and confirmed, and says so when there is none or it is already there', async () => {
    const runAt = (threshold) => async (value) => fake(value >= threshold ? [['A', 20]] : [], value * 100);
    const criterion = (summary) => summary.failures.length > 0;
    const found = await findBreakingPoint({ run: runAt(0.3721), criterion, low: 0, high: 1 });
    assert.equal(found.status, 'found');
    assert.ok(found.below < 0.3721 && found.above >= 0.3721, 'The gap holds the true threshold.');
    assert.ok(found.resolution < 0.002, `narrowed to ${found.resolution}`);
    assert.equal(found.confirmed, true);
    assert.equal(found.notMonotonic, false);
    assert.equal((await findBreakingPoint({ run: runAt(5), criterion, low: 0, high: 1 })).status, 'none');
    assert.equal((await findBreakingPoint({ run: runAt(-1), criterion, low: 0, high: 1 })).status, 'alreadyTrue');
    const twice = await findBreakingPoint({ run: async (value) => fake(value >= 0.3 && value < 0.6 ? [['A', 1]] : [], 0), criterion, low: 0, high: 1 });
    assert.equal(twice.status, 'found');
    assert.equal(twice.notMonotonic, true, 'A criterion that becomes true and then false again is reported, not hidden.');
    assert.equal(twice.crossings, 2);
    const stopped = await findBreakingPoint({ run: runAt(0.5), criterion, low: 0, high: 1, cancelled: () => true });
    assert.equal(stopped.status, 'cancelled');
});

test('sensitivity halves and raises each assumption by half, holds values to their hard limits, and flags a change in who fails', async () => {
    const current = { ...assumptionDefaults, reserveTargetShare: 0.6 };
    const seen = [];
    const run = async (change) => {
        seen.push(change);
        const reserve = change.reserveTargetShare ?? 0.6;
        return fake(reserve < 0.4 ? [] : reserve > 0.8 ? [['A', 10], ['B', 20]] : [['A', 10]], 100 * reserve + (change.fireSaleRate ? 5 : 0));
    };
    const controls = assumptionControls.filter((control) => ['reserveTargetShare', 'fireSaleRate'].includes(control.key));
    const result = await assumptionSensitivity({ run, current, controls });
    const reserve = result.rows.find((row) => row.key === 'reserveTargetShare');
    assert.equal(reserve.fragile, true);
    assert.deepEqual(reserve.changes.map((change) => [change.factor, change.failures]), [[0.5, 0], [1.5, 2]]);
    assert.equal(result.rows.find((row) => row.key === 'fireSaleRate').fragile, false);
    assert.deepEqual(seen.filter((change) => change.reserveTargetShare).map((change) => Number(change.reserveTargetShare.toFixed(6))), [0.3, 0.9]);
    const atLimit = await assumptionSensitivity({ run, current: { ...assumptionDefaults, reserveTargetShare: 1 }, controls: controls.slice(0, 1) });
    assert.equal(atLimit.rows[0].changes[1].skipped, true, 'A value already at its hard limit is not pushed past it.');
    const text = fragilityText(reserve, result.baseline);
    assert.equal(text.fragile, true);
    assert.match(text.text, /halving this: nobody fails/);
    assert.match(text.text, /raising it by half: 2 fail/);
    assert.doesNotMatch(text.text, /no effect/);
    const flat = await assumptionSensitivity({ run: async () => fake([['A', 10]], 100), current: assumptionDefaults, controls: controls.slice(1) });
    assert.match(fragilityText(flat.rows[0], flat.baseline).text, /\(no effect in this scenario\)/, 'An assumption that changes nothing here says so.');
});

test('a run is summarized from its series: who fails and when, total damage, and the lowest cash', () => {
    const data = { branches: [{ series: {} }, { series: { A: { equity: [[0, 100], [10, -5], [20, -5]], reserves: [[0, 50], [10, 3], [20, 4]] }, B: { equity: [[0, 100], [10, 90], [20, 60]], reserves: [[0, 50], [10, 40], [20, 30]] } } }] };
    const summary = summarizeRun(data, [{ name: 'A', equity: 100, cash: 50 }, { name: 'B', equity: 100, cash: 50 }]);
    assert.deepEqual(summary.failures, [{ name: 'A', day: 10 }]);
    assert.equal(summary.total, 105 + 40);
    assert.equal(summary.rows[0].lowestCash, 3);
});
