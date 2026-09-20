/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs Fintech Start against the real engine, headless. Needs a built engine (see the ReadMe); run with `npm run test:runs`.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { assumptionControls, assumptionDefaults } from '../../packages/start/lib/scenarioControls.mjs';
import { assumptionSensitivity, failingNames, findBreakingPoint, rankInstitutions } from '../../packages/start/lib/explore.mjs';
import { buildRequest, defaultControls } from '../../packages/start/lib/scenarioRequest.mjs';
import { buildModel, release, runScenario, startPackage } from '../../scripts/startHarness.mjs';

const pack = await startPackage();
const model = await buildModel(pack);
assert.equal(model.imported.ok, true, JSON.stringify(model.imported.report?.errors));
const names = model.imported.report.institutions.map((row) => row.name);
const cache = new Map([['auto', model]]);
const modelFor = async (options, exposures = 'given') => { const key = JSON.stringify([options, exposures]); if (!cache.has(key)) cache.set(key, await buildModel(pack, { options, exposures })); return cache.get(key); };
after(async () => { for (const built of cache.values()) await release(built); await pack.remove(); });
const declared = (id) => ({ ...pack.manifest.contributes.scenarios.find((scenario) => scenario.scenarioId === id), interventions: pack.manifest.contributes.scenarios.find((scenario) => scenario.scenarioId === id).interventions.map(({ parameter, target, value, fractionOfMaximum, at, duration }) => ({ parameter, target, value: value ?? null, fractionOfMaximum: fractionOfMaximum ?? null, at: at ?? 0, duration: duration ?? 0 })) });
const describe = (summary) => `${Math.round(summary.total)} ${summary.failures.map((failure) => `${failure.name.split(' ')[0]}@${failure.day}`).join(',') || 'none'}`;
const alder = { entity: 'Alder Bank' };
const severe = (extra = {}) => runScenario(pack, extra.model ?? model, 'runWithPriceShock', { ...alder, ...extra.request });

test('with every control at its default, the four scenarios give exactly the results they always have', async () => {
    const expected = {
        depositorRun: { total: 8615, failing: [] },
        runWithPriceShock: { total: 49339, failing: [['Alder Bank', 14], ['Holly Bank', 47.5], ['Fir Bank', 52.5]] },
        runWithCentralBankSupport: { total: 13169, failing: [['Alder Bank', 48]] },
        marketWideRun: { total: 38852, failing: [] }
    };
    for (const [id, target] of Object.entries(expected)) {
        const item = declared(id);
        const defaults = defaultControls(item, { entity: 'Alder Bank', names });
        const request = buildRequest(item, structuredClone(defaults), defaults, model.imported.parameterIndex);
        assert.equal(request.overrides, null);
        const { summary } = await runScenario(pack, model, id, { ...alder, overrides: request.overrides, runTime: request.runTime });
        assert.equal(Math.round(summary.total), target.total, `${id}: total damage`);
        assert.deepEqual(summary.failures.map((failure) => [failure.name, failure.day]), target.failing, `${id}: who fails and when`);
    }
});

test('restating the defaults as overrides gives the same run as leaving them out, and a real change gives a different one', async () => {
    const plain = (await severe()).summary;
    const restated = (await severe({ request: { overrides: { withdrawalRate: { 'Alder Bank': { value: 0.015, at: 0, duration: 8 } }, baseHaircut: { '*': { value: 0.5 } } } } })).summary;
    assert.equal(describe(restated), describe(plain));
    const milder = (await severe({ request: { overrides: { baseHaircut: { '*': { value: 0.3 } } } } })).summary;
    assert.notEqual(describe(milder), describe(plain));
    assert.deepEqual(failingNames(milder), ['Alder Bank']);
});

test('several institutions can be stressed at once, each at its own rate, and one can be left out', async () => {
    const item = declared('depositorRun');
    const defaults = defaultControls(item, { entity: 'Alder Bank', names });
    const controls = structuredClone(defaults);
    controls.stressed = { 'Alder Bank': 0.02, 'Dune Bank': 0.01 };
    controls.haircut = 0.5;
    const request = buildRequest(item, controls, defaults, model.imported.parameterIndex);
    const { summary, data } = await runScenario(pack, model, 'depositorRun', { ...alder, overrides: request.overrides });
    assert.deepEqual(data.interventions.filter((change) => change.parameter === 'withdrawalRate').map((change) => [change.entity, change.value]), [['Alder Bank', 0.02], ['Dune Bank', 0.01]]);
    assert.ok(failingNames(summary).includes('Alder Bank'));
    const none = buildRequest(item, { ...structuredClone(defaults), stressed: {} }, defaults, model.imported.parameterIndex);
    assert.equal((await runScenario(pack, model, 'depositorRun', { ...alder, overrides: none.overrides })).summary.total < 1, true, 'Stressing nobody leaves the baseline.');
});

test('a longer simulation runs longer, and a start delay moves the run later', async () => {
    const long = await runScenario(pack, model, 'runWithPriceShock', { ...alder, runTime: 90 });
    assert.equal(long.data.runTime, 90);
    assert.equal(long.samples.at(-1).time, 90);
    const late = await runScenario(pack, model, 'depositorRun', { ...alder, overrides: { withdrawalRate: { 'Alder Bank': { value: 0.015, at: 3, duration: 8 } } } });
    const early = await runScenario(pack, model, 'depositorRun', alder);
    assert.notEqual(Math.round(late.summary.total), Math.round(early.summary.total), 'Starting three days later gives a different outcome.');
    assert.ok(late.summary.total > 0 && early.summary.total > 0);
});

test('the four network options each match an independently built run', async () => {
    const auto = (await severe()).summary;
    // Estimated: the same as building from a file with no exposures, which estimates from each institution's interbank totals.
    const estimated = (await severe({ model: await modelFor({ network: 'estimated' }) })).summary;
    const fromTotals = (await severe({ model: await modelFor({}, 'none') })).summary;
    assert.equal(describe(estimated), describe(fromTotals));
    assert.notEqual(describe(estimated), describe(auto), 'The estimated network gives a different answer.');
    // Frozen: the default model with the lending and default edges taken out, everything else as it was.
    const frozen = (await severe({ model: await modelFor({ network: 'frozen' }) })).summary;
    const stripped = structuredClone(model.imported);
    stripped.document.edges = stripped.document.edges.filter((edge) => !/^(Interbank|Default)/.test(edge.name));
    const strippedModel = { imported: stripped, content: JSON.stringify(stripped.document), baselines: new Map() };
    const byHand = (await runScenario(pack, strippedModel, 'runWithPriceShock', alder)).summary;
    await release(strippedModel);
    assert.equal(describe(frozen), describe(byHand));
    // None: the sample data with each net interbank position settled in cash by hand and no interbank columns, built as given.
    const rows = (await import('node:fs/promises')).readFile;
    const text = await rows(new URL('../../packages/start/samples/institutions.csv', import.meta.url), 'utf8');
    const lines = text.trim().split('\n');
    const header = lines[0].split(',');
    const column = (name) => header.indexOf(name);
    const settled = [lines[0], ...lines.slice(1).map((line) => {
        const cells = line.split(',');
        const number = (name) => Number(cells[column(name)]);
        cells[column('cash_and_reserves')] = String(number('cash_and_reserves') + number('interbank_assets') - number('interbank_liabilities'));
        cells[column('interbank_assets')] = '0';
        cells[column('interbank_liabilities')] = '0';
        return cells.join(',');
    })].join('\n');
    const handSettled = await buildModel(pack, { exposures: 'none', institutionsText: `${settled}\n` });
    const none = (await severe({ model: await modelFor({ network: 'none' }) })).summary;
    const noneByHand = (await runScenario(pack, handSettled, 'runWithPriceShock', alder)).summary;
    await release(handSettled);
    assert.equal(describe(none), describe(noneByHand));
    console.log(`Network options, severe shock on Alder: as given ${describe(auto)}; estimated ${describe(estimated)}; frozen ${describe(frozen)}; none ${describe(none)}`);
});

test('a setting that is changed reaches the run: a shallower market makes the same shock worse, and the model matches its own rebuild', async () => {
    const plain = (await severe()).summary;
    const shallow = (await severe({ model: await modelFor({ assumptions: { marketDepthShare: 0.4 } }) })).summary;
    assert.ok(shallow.total > plain.total, `damage ${Math.round(plain.total)} -> ${Math.round(shallow.total)}`);
    const again = await buildModel(pack, { options: { assumptions: { marketDepthShare: 0.4 } } });
    assert.equal(describe((await runScenario(pack, again, 'runWithPriceShock', alder)).summary), describe(shallow));
    await release(again);
});

test('every assumption can be set to both of its hard limits, and the model still builds and runs', async () => {
    for (const control of assumptionControls) {
        for (const value of [control.hardMin, control.hardMax]) {
            const extreme = await buildModel(pack, { options: { assumptions: { [control.key]: value } } });
            assert.equal(extreme.imported.ok, true, `${control.key} = ${value}: ${JSON.stringify(extreme.imported.report?.errors)}`);
            const { summary } = await runScenario(pack, extreme, 'runWithPriceShock', alder);
            assert.ok(Number.isFinite(summary.total), `${control.key} = ${value} runs to a finite result`);
            for (const row of summary.rows) assert.ok(Number.isFinite(row.end) && Number.isFinite(row.lowestCash), `${control.key} = ${value}: ${row.name} has finite figures`);
            await release(extreme);
        }
    }
});

test('ranking gives, for each institution, the same numbers as a separate run of the same shock on it', async () => {
    const request = (name) => ({ entity: name });
    const ranked = await rankInstitutions({ names, concurrency: 2, run: async (name) => (await runScenario(pack, model, 'runWithPriceShock', request(name))).summary });
    assert.equal(ranked.length, names.length);
    for (const row of ranked) {
        const alone = (await runScenario(pack, model, 'runWithPriceShock', request(row.name))).summary;
        assert.equal(Math.round(row.total), Math.round(alone.total), `${row.name}: total`);
        assert.deepEqual(row.failed, failingNames(alone), `${row.name}: who fails`);
        assert.equal(row.firstFailureDay, alone.failures[0]?.day ?? null, `${row.name}: first failure`);
    }
    assert.deepEqual(ranked.map((row) => row.name).slice(0, 2), ['Alder Bank', 'Dune Bank'], 'Alder is the worst case, then Dune.');
    assert.equal(Math.round(ranked[0].total), 49339);
    assert.equal(Math.round(ranked.find((row) => row.name === 'Dune Bank').total), 42085);
    assert.ok(ranked.every((row, index) => index === 0 || ranked[index - 1].total >= row.total), 'Worst damage first.');
});

test('the breaking point of the haircut is confirmed by running just below and just above it, and by hand', async () => {
    const run = async (value) => (await runScenario(pack, model, 'runWithPriceShock', { ...alder, overrides: { baseHaircut: { '*': { value } } } })).summary;
    const result = await findBreakingPoint({ run, criterion: (summary) => failingNames(summary).includes('Alder Bank'), low: 0.1, high: 1 });
    assert.equal(result.status, 'found');
    assert.equal(result.confirmed, true);
    assert.ok(result.below >= 0.1 && result.above <= 1 && result.above > result.below);
    assert.ok(result.resolution < 0.01, `resolution ${result.resolution}`);
    // Independently: a fresh run just below does not fail Alder, and one just above does.
    assert.equal(failingNames(await run(result.below)).includes('Alder Bank'), false);
    assert.equal(failingNames(await run(result.above)).includes('Alder Bank'), true);
    assert.ok(result.above > 0.1 && result.above < 0.2, `Alder first fails at a haircut of about ${result.above.toFixed(3)}`);
    // The cascade threshold, where a second institution fails, is higher.
    const second = await findBreakingPoint({ run, criterion: (summary) => failingNames(summary).some((name) => name !== 'Alder Bank'), low: 0.1, high: 1 });
    assert.equal(second.status, 'found');
    assert.equal(second.confirmed, true);
    assert.ok(second.above > result.above, 'The cascade needs a harsher discount than the first failure.');
    console.log(`Breaking points, run on Alder at 1.5% a day: Alder fails from a haircut of ${result.above.toFixed(3)}; a second institution fails from ${second.above.toFixed(3)} (crossings ${result.crossings}/${second.crossings})`);
});

test('the breaking point of the withdrawal rate is found the same way', async () => {
    const run = async (value) => (await runScenario(pack, model, 'runWithPriceShock', { ...alder, overrides: { withdrawalRate: { 'Alder Bank': { value, at: 0, duration: 8 } } } })).summary;
    const result = await findBreakingPoint({ run, criterion: (summary) => failingNames(summary).includes('Alder Bank'), low: 0, high: 0.05 });
    assert.equal(result.status, 'found');
    assert.equal(result.confirmed, true);
    assert.ok(result.above > 0.005 && result.above < 0.011, `Alder first fails at a withdrawal rate of about ${result.above.toFixed(4)}`);
});

test('sensitivity matches separate runs of each changed assumption, and flags the reserve target as fragile', async () => {
    const run = async (change) => (await runScenario(pack, await modelFor({ assumptions: change }), 'runWithPriceShock', alder)).summary;
    const controls = assumptionControls.filter((control) => ['reserveTargetShare', 'fireSaleRate', 'writeDownRate'].includes(control.key));
    const result = await assumptionSensitivity({ run, current: assumptionDefaults, controls });
    const reserve = result.rows.find((row) => row.key === 'reserveTargetShare');
    assert.equal(reserve.fragile, true, 'Changing the reserve target changes who fails.');
    const half = reserve.changes.find((change) => change.factor === 0.5);
    assert.equal(half.failures, 0, 'Halving the reserve target: nobody fails.');
    assert.ok(half.damageChange < -0.5, `and damage falls (${(100 * half.damageChange).toFixed(0)}%)`);
    const separate = await run({ reserveTargetShare: 0.05 });
    assert.equal(Math.round(half.total), Math.round(separate.total), 'The sensitivity figure is the separate run.');
    const writeDown = result.rows.find((row) => row.key === 'writeDownRate');
    assert.ok(writeDown.changes.every((change) => Math.abs(change.total - result.baseline.total) < 1), 'The write-down rate moves timing, not total damage.');
    console.log(`Sensitivity (severe shock on Alder): ${result.rows.map((row) => `${row.label} ${row.changes.map((change) => `${change.factor}x ${Math.round(100 * change.damageChange)}%/${change.failures}fail`).join(' ')}${row.fragile ? ' [fragile]' : ''}`).join('; ')}`);
});
