/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { checkValue, shockControls } from './scenarioControls.mjs';

// Turns the settings on the scenario page into what a run is asked to do. A scenario declares its own changes in the manifest; the window
// starts every control at the declared value, and asks the host for a change only where a control differs from it. With every control at
// its default the request is empty, so the run is exactly the declared scenario.

const declaredOf = (scenario, parameter) => scenario.interventions.find((intervention) => intervention.parameter === parameter) ?? null;

// The controls as a scenario declares them. `names` is every institution, `entity` the one chosen (for a scenario that chooses one) and
// `parameterIndex`-like `haircutDefault` the model's own haircut, used where a scenario does not declare one.
export function defaultControls(scenario, { entity = null, names = [], haircutDefault = 0.1 } = {}) {
    const withdrawal = declaredOf(scenario, 'withdrawalRate');
    const haircut = declaredOf(scenario, 'baseHaircut');
    const support = declaredOf(scenario, 'emergencyLending');
    const stressed = {};
    if (withdrawal) for (const name of withdrawal.target === 'all' ? names : entity ? [entity] : []) stressed[name] = withdrawal.value;
    return {
        stressed,
        start: withdrawal?.at ?? 0,
        duration: withdrawal?.duration || 8,
        haircut: haircut?.value ?? haircutDefault,
        support: { on: Boolean(support), size: support?.fractionOfMaximum ?? 0.5, delay: support?.at ?? 3 },
        runLength: scenario.runTime
    };
}

// What a run is asked to change: { overrides, runTime, changed }, where `changed` lists, in words, every control that is not at its default.
// `index` is the importer's parameter index, used to turn a fraction of the facility into an amount for each institution.
export function buildRequest(scenario, controls, defaults, index) {
    const overrides = {};
    const changed = [];
    const withdrawal = declaredOf(scenario, 'withdrawalRate');
    const rateChange = {};
    const sameRun = controls.start === defaults.start && controls.duration === defaults.duration;
    for (const name of new Set([...Object.keys(defaults.stressed), ...Object.keys(controls.stressed)])) {
        if (!(name in controls.stressed)) { rateChange[name] = null; changed.push(`${name} is not stressed`); continue; }
        const isDefault = name in defaults.stressed && controls.stressed[name] === defaults.stressed[name] && sameRun;
        if (isDefault) continue;
        rateChange[name] = { value: controls.stressed[name], at: controls.start, duration: controls.duration };
        changed.push(name in defaults.stressed ? `${name} withdrawal rate, start or duration` : `${name} is also stressed`);
    }
    if (Object.keys(rateChange).length) overrides.withdrawalRate = rateChange;

    if (controls.haircut !== defaults.haircut) { overrides.baseHaircut = { '*': { value: controls.haircut } }; changed.push('forced-sale discount'); }

    const supportChange = {};
    const supportDefault = defaults.support;
    const supported = Object.keys(controls.stressed);
    for (const name of new Set([...(supportDefault.on ? Object.keys(defaults.stressed) : []), ...(controls.support.on ? supported : [])])) {
        const wasOn = supportDefault.on && name in defaults.stressed;
        const isOn = controls.support.on && supported.includes(name);
        if (wasOn && !isOn) { supportChange[name] = null; continue; }
        if (!isOn) continue;
        if (wasOn && controls.support.size === supportDefault.size && controls.support.delay === supportDefault.delay) continue;
        const entry = index.find((candidate) => candidate.key === 'emergencyLending' && candidate.entity === name);
        if (entry) supportChange[name] = { value: controls.support.size * entry.maximum, at: controls.support.delay, duration: 0 };
    }
    if (Object.keys(supportChange).length) {
        overrides.emergencyLending = supportChange;
        changed.push(controls.support.on ? 'central-bank support' : 'no central-bank support');
    }

    const runTime = controls.runLength === scenario.runTime ? null : controls.runLength;
    if (runTime !== null) changed.push('length of the simulation');
    return { overrides: Object.keys(overrides).length ? overrides : null, runTime, changed: [...new Set(changed)] };
}

// Every problem with the shock controls, as plain sentences. A value outside a hard limit is a problem; one outside the advisory band is not
// (it is returned in `advice` so the window can say so beside the control).
export function checkControls(scenario, controls) {
    const problems = [];
    const advice = {};
    const check = (control, value, label, hardMax) => {
        const result = checkValue(control, value, hardMax);
        if (!result.ok) problems.push(result.message.replace(control.label, label ?? control.label));
        else if (result.advisory) advice[label ?? control.label] = result.advisory;
    };
    const run = controls.runLength;
    check(shockControls.runLength, run);
    if (run <= scenario.forkAt) problems.push(`The simulation must run longer than the ${scenario.forkAt} days before the shock.`);
    const remaining = Math.max(0, run - scenario.forkAt);
    for (const [name, rate] of Object.entries(controls.stressed)) check(shockControls.withdrawalRate, rate, `Withdrawal rate for ${name}`);
    if (Object.keys(controls.stressed).length) {
        check(shockControls.start, controls.start, 'Start', remaining);
        check(shockControls.duration, controls.duration, 'Duration', remaining);
    }
    check(shockControls.haircut, controls.haircut);
    if (controls.support.on) {
        check(shockControls.supportSize, controls.support.size);
        check(shockControls.supportDelay, controls.support.delay, 'Support start', remaining);
    }
    return { problems, advice };
}
