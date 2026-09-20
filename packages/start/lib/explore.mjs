/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { assumptionControls } from './scenarioControls.mjs';

// The views that run a scenario many times: ranking every institution, finding where a control makes an institution fail, and seeing
// how much each assumption matters. Each takes a `run` function that performs one ordinary run and returns its summary, so the same code
// drives the window and the tests, and every number in these views is the number a single run gives.

// One run in brief, from the data a run returns (series of equity and cash for the baseline and the scenario).
export function summarizeRun(data, institutions) {
    const scenario = data.branches[1];
    const rows = institutions.map((institution) => {
        const equity = scenario.series[institution.name]?.equity ?? [];
        const cash = scenario.series[institution.name]?.reserves ?? [];
        const start = equity[0]?.[1] ?? institution.equity;
        return {
            name: institution.name, start, end: equity.at(-1)?.[1] ?? start,
            failure: equity.find(([, value]) => value < 0)?.[0] ?? null,
            lowestCash: cash.length ? Math.min(...cash.map(([, value]) => value)) : institution.cash
        };
    });
    const failures = rows.filter((row) => row.failure !== null).map((row) => ({ name: row.name, day: row.failure })).sort((a, b) => a.day - b.day);
    return { rows, failures, total: rows.reduce((sum, row) => sum + row.start - row.end, 0) };
}

const sameSet = (left, right) => left.length === right.length && left.every((name) => right.includes(name));
export const failingNames = (summary) => summary.failures.map((failure) => failure.name);

// ---- ranking ----------------------------------------------------------------------------------------------

// The same shock on each institution in turn, worst first. `run(name)` performs the run with that institution stressed.
export async function rankInstitutions({ names, run, concurrency = 2, onProgress = () => {}, cancelled = () => false }) {
    const results = new Array(names.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < names.length && !cancelled()) {
            const index = next;
            next += 1;
            const summary = await run(names[index]);
            results[index] = { name: names[index], summary };
            done += 1;
            onProgress({ done, total: names.length });
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
    return results.filter(Boolean).map(({ name, summary }) => ({
        name, total: summary.total, failures: summary.failures.length, failed: failingNames(summary),
        firstFailureDay: summary.failures[0]?.day ?? null, ownFailureDay: summary.failures.find((failure) => failure.name === name)?.day ?? null
    })).sort((a, b) => b.total - a.total || b.failures - a.failures);
}

// ---- breaking point ---------------------------------------------------------------------------------------

// Where, between `low` and `high`, a criterion first becomes true as a control is raised. `run(value)` performs the run with the control at
// that value and `criterion(summary)` says whether it has happened. The range is scanned at `points` evenly spaced values, the first change is
// narrowed by bisection, and the two runs either side of the narrowed gap are performed again to confirm it. The answer says how it was found:
// the first change found, at a stated resolution, and whether the criterion changes more than once over the range.
export async function findBreakingPoint({ run, criterion, low, high, points = 12, bisections = 6, onProgress = () => {}, cancelled = () => false }) {
    const values = Array.from({ length: points }, (_, index) => low + ((high - low) * index) / (points - 1));
    const scan = [];
    for (const value of values) {
        if (cancelled()) return { status: 'cancelled', scan };
        const summary = await run(value);
        scan.push({ value, hit: criterion(summary), failures: summary.failures.length, total: summary.total });
        onProgress({ stage: 'scan', done: scan.length, total: points });
    }
    const crossings = scan.slice(1).filter((point, index) => point.hit !== scan[index].hit).length;
    const first = scan.findIndex((point) => point.hit);
    if (first < 0) return { status: 'none', scan, crossings };
    if (first === 0) return { status: 'alreadyTrue', scan, crossings, value: scan[0].value };
    let below = scan[first - 1].value;
    let above = scan[first].value;
    for (let step = 0; step < bisections; step += 1) {
        if (cancelled()) return { status: 'cancelled', scan };
        const middle = (below + above) / 2;
        if (criterion(await run(middle))) above = middle; else below = middle;
        onProgress({ stage: 'narrow', done: step + 1, total: bisections });
    }
    // The confirmation: just below and just above the gap, each run again from scratch.
    const belowSummary = await run(below);
    const aboveSummary = await run(above);
    return {
        status: 'found', below, above, resolution: above - below, scan, crossings, notMonotonic: crossings > 1,
        confirmed: !criterion(belowSummary) && criterion(aboveSummary), belowSummary, aboveSummary
    };
}

// ---- sensitivity ------------------------------------------------------------------------------------------

// Each assumption halved and raised by half around its current value, one at a time. `run(assumptions)` performs the run with those
// assumptions changed (it rebuilds the model). A value beyond a hard limit is held to it, and a change that would leave the value where it
// is, because it is already at the limit, is left out.
export async function assumptionSensitivity({ run, current, factors = [0.5, 1.5], controls = assumptionControls, onProgress = () => {}, cancelled = () => false }) {
    const baseline = await run({});
    const rows = [];
    let done = 0;
    const total = controls.length * factors.length;
    for (const control of controls) {
        const row = { key: control.key, label: control.label, value: current[control.key], changes: [] };
        for (const factor of factors) {
            if (cancelled()) return { baseline, rows, cancelled: true };
            const value = Math.min(Math.max(current[control.key] * factor, control.hardMin), control.hardMax);
            done += 1;
            onProgress({ done, total });
            if (value === current[control.key]) { row.changes.push({ factor, value, skipped: true }); continue; }
            const summary = await run({ [control.key]: value });
            row.changes.push({
                factor, value, total: summary.total, failures: summary.failures.length, failed: failingNames(summary),
                damageChange: baseline.total ? summary.total / baseline.total - 1 : null, setChanged: !sameSet(failingNames(summary), failingNames(baseline))
            });
        }
        row.fragile = row.changes.some((change) => change.setChanged);
        row.largest = Math.max(0, ...row.changes.filter((change) => !change.skipped).map((change) => Math.abs(change.damageChange ?? 0)));
        rows.push(row);
    }
    return { baseline, rows: rows.sort((a, b) => b.largest - a.largest) };
}

// The plain sentence beside an assumption: what happens to who fails when it is halved and when it is raised by half.
export function fragilityText(row, baseline) {
    const describe = (change) => {
        if (change.skipped) return null;
        const label = change.factor < 1 ? 'halving this' : 'raising it by half';
        const who = change.failures === 0 ? 'nobody fails' : change.failures === 1 ? `${change.failed[0]} fails` : `${change.failures} fail`;
        const damage = change.damageChange === null ? '' : `, damage ${change.damageChange >= 0 ? '+' : '−'}${Math.abs(Math.round(100 * change.damageChange))}%`;
        return `${label}: ${who}${damage}`;
    };
    const parts = row.changes.map(describe).filter(Boolean);
    const unchanged = row.changes.every((change) => change.skipped || (Math.abs(change.damageChange ?? 0) < 1e-9 && !change.setChanged));
    return { text: `${parts.join('; ')}${unchanged && parts.length ? ' (no effect in this scenario)' : ''}`, fragile: row.fragile, baselineFailing: baseline.failures.length };
}
