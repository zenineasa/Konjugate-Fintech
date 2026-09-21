/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The settings a user can change in Fintech Start, described once and shared by the importer (which validates the assumptions it is
// given and builds the model from them) and the window (which draws the controls, marks what has changed, and turns them into the
// changes a run is asked to make).
//
// Every setting has a default, a hard limit and an advisory band. The hard limit is the widest range where the model still works: it is
// the only thing enforced, and a value outside it is refused with a reason. The advisory band is roughly half to one and a half times the
// default, the region the model was explored over. Outside it the window says so and the run goes ahead. Nothing here is calibrated to a
// real institution, and the bands are not a view of what is realistic.

// ---- assumptions: they rebuild the model ------------------------------------------------------------------

export const assumptionControls = [
    { key: 'reserveTargetShare', label: 'Reserve target', unit: 'of deposits', percent: true, default: 0.1, hardMin: 0.001, hardMax: 1, advisoryMin: 0.05, advisoryMax: 0.2, step: 0.005,
        note: 'Cash an institution wants to hold; stress starts when cash falls below it. Each institution\'s target is the smaller of this share of its deposits and the cash it holds now, so raising the share beyond an institution\'s cash changes nothing for that institution. It also sets where the panic and the forced sales start, so it moves several things at once.' },
    { key: 'fireSaleRate', label: 'Forced-sale speed', unit: 'of loans per day', percent: true, default: 0.02, hardMin: 0, hardMax: 1, advisoryMin: 0.01, advisoryMax: 0.03, step: 0.005,
        note: 'How fast an institution short of cash sells loans into the market.' },
    { key: 'marketDepthShare', label: 'Market depth', unit: 'of total loans', percent: true, default: 0.8333, hardMin: 0.01, hardMax: 10, advisoryMin: 0.42, advisoryMax: 1.25, step: 0.05,
        note: 'How much the market can absorb before prices fall. Smaller means forced sales move prices more (this sets the price impact).' },
    { key: 'flowRate', label: 'Interbank lending speed', unit: 'per day', percent: false, default: 0.05, hardMin: 0, hardMax: 1, advisoryMin: 0.025, advisoryMax: 0.075, step: 0.005,
        note: 'How fast cash moves along interbank links towards institutions that are short of it.' },
    { key: 'panicSensitivity', label: 'Panic sensitivity', unit: '', percent: false, default: 4, hardMin: 0, hardMax: 50, advisoryMin: 2, advisoryMax: 6, step: 0.5,
        note: 'How much faster depositors withdraw as cash falls below the target.' },
    { key: 'writeDownRate', label: 'Speed losses reach creditors', unit: 'per day', percent: false, default: 1, hardMin: 0.01, hardMax: 5, advisoryMin: 0.5, advisoryMax: 1.5, step: 0.05,
        note: 'How quickly a failed institution\'s shortfall is passed to its creditors. It moves when second-round failures happen, not how much is lost in total.' },
    { key: 'centralBankShare', label: 'Central-bank reserves', unit: 'of total deposits', percent: true, default: 0.25, hardMin: 0, hardMax: 5, advisoryMin: 0.125, advisoryMax: 0.375, step: 0.025,
        note: 'How much the central bank holds to lend.' },
    { key: 'facilityShare', label: 'Central-bank facility', unit: 'of deposits per day, at most', percent: true, default: 0.1, hardMin: 0.001, hardMax: 1, advisoryMin: 0.05, advisoryMax: 0.15, step: 0.005,
        note: 'The most the central bank can lend an institution in a day. Support in a scenario is a fraction of this.' }
];

// How the interbank network is treated. "auto" is how the model has always been built: the exposures as given, or estimated from each
// institution's totals when no exposures were given.
export const networkOptions = [
    { key: 'auto', label: 'Exposures as given (estimated if none were given)' },
    { key: 'estimated', label: 'Estimated from each institution\'s interbank totals' },
    { key: 'frozen', label: 'Interbank frozen: claims and borrowing stay at book value, no lending flows and no losses passed on' },
    { key: 'none', label: 'No interbank exposure: each institution settles its net interbank position in cash, and the balances are removed' }
];

export const assumptionDefaults = Object.fromEntries(assumptionControls.map((control) => [control.key, control.default]));

// Checks the options an importer is given. Returns { settings, network, problems }: the assumptions with any that were not given filled in
// from the defaults, and a plain sentence for everything that is wrong.
export function readOptions(options = {}) {
    const problems = [];
    const given = options?.assumptions ?? {};
    const settings = { ...assumptionDefaults };
    for (const [key, value] of Object.entries(given)) {
        const control = assumptionControls.find((candidate) => candidate.key === key);
        if (!control) { problems.push(`"${key}" is not a setting this window has.`); continue; }
        const check = checkValue(control, value);
        if (!check.ok) problems.push(check.message); else settings[key] = value;
    }
    const network = options?.network ?? 'auto';
    if (!networkOptions.some((option) => option.key === network)) problems.push(`"${network}" is not one of the ways to treat the interbank network.`);
    return { settings, network, problems };
}

// ---- shocks: they change a run, not the model ----------------------------------------------------------

// `hardMax` of null means "the length of the run", filled in by the caller.
export const shockControls = {
    withdrawalRate: { key: 'withdrawalRate', label: 'Withdrawal rate', unit: 'of deposits per day', percent: true, hardMin: 0, hardMax: 1, advisoryMin: 0.005, advisoryMax: 0.03, step: 0.001,
        note: 'How much of an institution\'s deposits depositors withdraw each day while the run lasts.' },
    start: { key: 'start', label: 'Start', unit: 'days after the fork', percent: false, hardMin: 0, hardMax: null, advisoryMin: 0, advisoryMax: 10, step: 0.5, note: 'How long after the fork (day 5) the run on the institution starts.' },
    duration: { key: 'duration', label: 'Duration of the run on the institution', unit: 'days', percent: false, hardMin: 0.5, hardMax: null, advisoryMin: 1, advisoryMax: 20, step: 0.5, note: 'How long depositors keep withdrawing.' },
    haircut: { key: 'haircut', label: 'Forced-sale discount', unit: 'below book value', percent: true, hardMin: 0, hardMax: 1, advisoryMin: 0, advisoryMax: 0.7, step: 0.05,
        note: 'How far below book value a forced sale fetches, for every institution. 100% means sales fetch nothing.' },
    supportSize: { key: 'supportSize', label: 'Central-bank support', unit: 'of the facility maximum', percent: true, hardMin: 0, hardMax: 1, advisoryMin: 0.25, advisoryMax: 0.75, step: 0.05,
        note: 'How much of its facility the central bank lends while the institution is short of cash.' },
    supportDelay: { key: 'supportDelay', label: 'Support begins', unit: 'days after the fork', percent: false, hardMin: 0, hardMax: null, advisoryMin: 0, advisoryMax: 6, step: 0.5, note: 'How long after the fork (day 5) the central bank starts lending.' },
    runLength: { key: 'runLength', label: 'Length of the simulation', unit: 'days', percent: false, hardMin: 6, hardMax: 120, advisoryMin: 30, advisoryMax: 90, step: 5, note: 'How many days are simulated. The longer, the more second-round failures show up.' }
};

// ---- checking a value ---------------------------------------------------------------------------------

const show = (control, value) => (control.percent ? `${Number((100 * value).toPrecision(4))}%` : `${Number(value.toPrecision(4))}`);

// { ok: false, message } for a value outside the hard limit, { ok: true, advisory } otherwise, where advisory is 'below', 'above' or null.
export function checkValue(control, value, hardMax = control.hardMax) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, message: `${control.label} must be a number.` };
    if (value < control.hardMin) return { ok: false, message: `${control.label} cannot be below ${show(control, control.hardMin)}.` };
    if (hardMax !== null && value > hardMax) return { ok: false, message: `${control.label} cannot be above ${show(control, hardMax)}.` };
    return { ok: true, advisory: value < control.advisoryMin ? 'below' : value > control.advisoryMax ? 'above' : null };
}

export const advisoryText = (control, advisory) => (advisory
    ? `Outside the range this model has been explored over (${show(control, control.advisoryMin)} to ${show(control, control.advisoryMax)}). The run goes ahead.`
    : '');

export { show as formatValue };
