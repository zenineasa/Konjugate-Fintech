/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Calibration study: can Konjugate's fitting engine recover a behavioral constant of the interbank
// model from noisy "historical" data? A model with a known panic sensitivity generates the history;
// a copy that starts from a wrong value and marks the shared constant tunable is fitted to it. The
// panic sensitivity is one shared parameter used by several edges, so this also exercises fitting a
// shared parameter. Uses the sibling Konjugate's engine directly (no GUI).

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { buildModelDocument } from '../../scripts/buildModels.mjs';
import { konjugateDir, konjugateModule } from '../../scripts/konjugatePaths.mjs';

const { fitWithEngine, runWithEngine } = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };

const truePanic = 6;
const startingPanic = 4;
const days = 30;
const step = 0.1;

// A small seeded generator so the "noise" is the same on every run.
function seeded(seed) {
    let state = seed;
    const uniform = () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

// History: the model with the true constant, observed on bank A only, with measurement noise.
const truth = buildModelDocument('interbankLiquidityRun', { shared: { panicSensitivity: { value: truePanic } } });
const run = await runWithEngine(JSON.stringify(truth.document), { name: 'History', targetTime: days, globalTimeStep: step, outputInterval: step }, engineOptions);
assert.equal(run.available, true, 'The Konjugate engine is not built; run `npm run build:engine` in the Konjugate checkout.');
const observed = [['Bank A — Reserves (M)', 'Bank A.reserves'], ['Bank A — Deposits (M)', 'Bank A.deposits'], ['Bank A — Equity (M)', 'Bank A.equity']];
const noise = seeded(2026);
const rows = run.result.samples.map((sample) => [sample.time.toFixed(6), ...observed.map(([, name]) =>
    (sample.states.find((state) => state.stateId === truth.states[name]).value + 0.3 * noise()).toFixed(6))].join(','));
const csv = [['time (days)', ...observed.map(([heading]) => heading)].join(','), ...rows].join('\n');

// Model to fit: same structure, wrong starting constant, marked tunable.
const guess = buildModelDocument('interbankLiquidityRun', {
    shared: { panicSensitivity: { value: startingPanic, tuning: { minimum: 0, maximum: 20 } } }
});
const fitted = await fitWithEngine(JSON.stringify(guess.document), csv, { maxIterations: 300 }, engineOptions);
assert.equal(fitted.available, true);
const panicId = guess.document.sharedParameters.find((shared) => shared.symbol === 'panicSensitivity').id;
assert.equal(fitted.report.finalParameters.length, 1, 'One shared parameter is one fitting variable, however many edges use it.');
const recovered = fitted.report.finalParameters.find((entry) => entry.parameterId === panicId).value;
console.log(`Panic sensitivity: true ${truePanic}, started at ${startingPanic}, recovered ${recovered.toFixed(3)} from ${rows.length} noisy observations of bank A.`);
assert.ok(Math.abs(recovered - truePanic) < 0.3, `Calibration should recover ${truePanic}, got ${recovered}`);
console.log('Calibration checks passed.');
