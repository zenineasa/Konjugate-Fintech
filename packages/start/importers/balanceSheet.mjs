/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Importer: balance sheets (and, optionally, bilateral interbank exposures) -> an interbank stress
// model. A pure function of the file texts: no file, network or clock access, so the same input
// always gives the same model, and every problem is reported against the row that caused it.
//
// The format is documented in help/dataFormat.html and is a first guess to be corrected with feedback
// from real users; nothing here is calibrated to a real institution.

import { detectDecimalSeparator, normalizeHeading, parseCsv, parseLocalizedNumber } from '../lib/csv.mjs';
import { NetworkBuilder, symbolFragment } from '../lib/networkBuilder.mjs';

const maximumInstitutions = 40;
const balanceTolerance = { absolute: 0.5, relative: 1e-4 };
const assumptions = {
    reserveTargetShareOfDeposits: 0.1,
    centralBankShareOfDeposits: 0.25,
    marketCashShareOfLoans: 0.5,
    marketDepthShareOfLoans: 0.8333,
    withdrawalRateMaximum: 0.2,
    emergencyLendingShareOfDepositsPerDay: 0.1
};

const institutionColumns = {
    institution: ['institution', 'name', 'bank'],
    cash: ['cashandreserves', 'cash', 'reserves'],
    loans: ['loansandsecurities', 'loans', 'externalassets'],
    interbankAssets: ['interbankassets'],
    deposits: ['depositsandotherliabilities', 'deposits', 'otherliabilities'],
    interbankLiabilities: ['interbankliabilities'],
    equity: ['equity', 'capital']
};
const exposureColumns = { lender: ['lender', 'creditor'], borrower: ['borrower', 'debtor'], amount: ['amount', 'exposure'] };
const canonicalNames = {
    institution: 'institution', cash: 'cash_and_reserves', loans: 'loans_and_securities', interbankAssets: 'interbank_assets',
    deposits: 'deposits_and_other_liabilities', interbankLiabilities: 'interbank_liabilities', equity: 'equity',
    lender: 'lender', borrower: 'borrower', amount: 'amount'
};

const format = (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });

function locateColumns(header, wanted) {
    const normalized = header.map(normalizeHeading);
    const found = {};
    for (const [key, aliases] of Object.entries(wanted)) {
        const index = normalized.findIndex((heading) => aliases.includes(heading));
        if (index >= 0) found[key] = index;
    }
    return found;
}

function parseNumber(text, decimal = '.') {
    if (String(text ?? '').trim() === '') return { blank: true };
    const value = parseLocalizedNumber(text, decimal);
    return Number.isFinite(value) ? { value } : { invalid: true };
}

const delimiterNames = { ',': 'commas', ';': 'semicolons', '\t': 'tabs' };

// Notes on how a file was read when that was not the plain default, so a surprising result can be traced
// to an assumption the user can check.
function readingNotes(fileName, file, parsed, decimal) {
    const notes = [];
    if (parsed.delimiter !== ',') notes.push(`${fileName} was read as separated by ${delimiterNames[parsed.delimiter]}.`);
    if (decimal === ',') notes.push(`${fileName} was read with a decimal comma (1.234,5 means 1234.5).`);
    if (file.encoding && file.encoding !== 'utf-8') notes.push(`${fileName} is not UTF-8 text and was read as ${file.encoding}; check that names with accents look right.`);
    return notes;
}

// Iterative proportional fitting with a zero diagonal: the maximum-entropy-style estimate of who lent
// to whom when only each institution's total interbank assets and liabilities are known, the
// standard fallback when the bilateral matrix is confidential (see the data-format guide).
function fitExposures(matrix, assets, liabilities) {
    const size = assets.length;
    for (let iteration = 0; iteration < 500; iteration += 1) {
        for (let row = 0; row < size; row += 1) {
            const sum = matrix[row].reduce((total, value) => total + value, 0);
            if (sum > 0) matrix[row] = matrix[row].map((value) => (value * assets[row]) / sum);
        }
        for (let column = 0; column < size; column += 1) {
            const sum = matrix.reduce((total, row) => total + row[column], 0);
            if (sum > 0) for (const row of matrix) row[column] = (row[column] * liabilities[column]) / sum;
        }
    }
    return matrix;
}

// The estimate spreads every institution's lending across all the others, which no real interbank market
// does and which makes a large network needlessly dense (and slow to draw). Each institution keeps only its
// largest counterparties in each direction, and the surviving links are refitted to the same totals.
const estimatedCounterpartyLimit = 10;
function estimateExposures(assets, liabilities) {
    const dense = fitExposures(assets.map((lent, row) => liabilities.map((borrowed, column) => (row === column ? 0 : lent * borrowed))), assets, liabilities);
    const size = assets.length;
    if (size - 1 <= estimatedCounterpartyLimit) return dense;
    const keep = dense.map((row) => row.map(() => false));
    const largest = (indexes, valueOf) => indexes.sort((left, right) => valueOf(right) - valueOf(left)).slice(0, estimatedCounterpartyLimit);
    for (let lender = 0; lender < size; lender += 1) {
        for (const borrower of largest([...dense[lender].keys()].filter((column) => column !== lender), (column) => dense[lender][column])) keep[lender][borrower] = true;
    }
    for (let borrower = 0; borrower < size; borrower += 1) {
        for (const lender of largest([...dense.keys()].filter((row) => row !== borrower), (row) => dense[row][borrower])) keep[lender][borrower] = true;
    }
    const pruned = fitExposures(dense.map((row, lender) => row.map((value, borrower) => (keep[lender][borrower] ? value : 0))), assets, liabilities);
    const total = (matrix) => matrix.reduce((sum, row) => sum + row.reduce((inner, value) => inner + value, 0), 0);
    const supports = (matrix) => matrix.every((row, lender) => assets[lender] === 0 || row.some((value) => value > 0)) &&
        liabilities.every((borrowed, column) => borrowed === 0 || matrix.some((row) => row[column] > 0));
    // Only use the pruned network if it still carries (almost) all the lending and reaches every institution.
    return supports(pruned) && Math.abs(total(pruned) - total(dense)) < 0.005 * total(dense) ? pruned : dense;
}

export default async function importData({ files, helpers }) {
    const errors = [];
    const warnings = [];
    const fail = (file, line, column, message) => errors.push({ file, line, column, message });
    const warn = (file, line, message) => warnings.push({ file, line, message });

    const institutionsFile = files.find((file) => file.role === 'institutions');
    const exposuresFile = files.find((file) => file.role === 'exposures' && file.text?.trim());
    if (!institutionsFile?.text?.trim()) {
        return { ok: false, report: { errors: [{ file: 'institutions', line: null, column: null, message: 'The institutions file is required: one row per institution with its balance sheet.' }], warnings: [], summary: null, institutions: [] } };
    }
    const institutionsName = institutionsFile.name ?? 'institutions.csv';
    const exposuresName = exposuresFile?.name ?? 'exposures.csv';

    // ---- institutions ------------------------------------------------------------------------------
    const parsed = parseCsv(institutionsFile.text);
    const located = locateColumns(parsed.header, institutionColumns);
    for (const key of ['institution', 'cash', 'loans', 'deposits']) {
        if (located[key] === undefined) fail(institutionsName, 1, canonicalNames[key], `The column "${canonicalNames[key]}" is missing. Headings found: ${parsed.header.join(', ') || 'none'}.`);
    }
    const numericKeys = ['cash', 'loans', 'interbankAssets', 'deposits', 'interbankLiabilities', 'equity'];
    const institutionsDecimal = detectDecimalSeparator(parsed.rows.flatMap(({ values }) => numericKeys.filter((key) => located[key] !== undefined).map((key) => values[located[key]])));
    for (const note of readingNotes(institutionsName, institutionsFile, parsed, institutionsDecimal)) warn(institutionsName, null, note);
    const hasInterbankAssetsColumn = located.interbankAssets !== undefined;
    const hasInterbankLiabilitiesColumn = located.interbankLiabilities !== undefined;
    const institutions = [];
    const byName = new Map();
    if (!errors.length) {
        for (const { line, values } of parsed.rows) {
            const name = String(values[located.institution] ?? '').trim();
            if (!name) { fail(institutionsName, line, canonicalNames.institution, 'The institution name is blank.'); continue; }
            if (byName.has(name.toLowerCase())) { fail(institutionsName, line, canonicalNames.institution, `"${name}" appears more than once (first on line ${byName.get(name.toLowerCase()).line}).`); continue; }
            const record = { name, line, blankEquity: false };
            for (const key of ['cash', 'loans', 'deposits', 'interbankAssets', 'interbankLiabilities', 'equity']) {
                if (located[key] === undefined) continue;
                const number = parseNumber(values[located[key]], institutionsDecimal);
                if (number.blank) {
                    if (key === 'equity') record.blankEquity = true;
                    else if (['cash', 'loans', 'deposits'].includes(key)) { record.invalid = true; fail(institutionsName, line, canonicalNames[key], `${name}: ${canonicalNames[key]} is blank.`); }
                } else if (number.invalid) { record.invalid = true; fail(institutionsName, line, canonicalNames[key], `${name}: "${values[located[key]]}" in ${canonicalNames[key]} is not a number.`); }
                else if (number.value < 0) { record.invalid = true; fail(institutionsName, line, canonicalNames[key], `${name}: ${canonicalNames[key]} is negative (${format(number.value)}); balances must be zero or more.`); }
                else record[key] = number.value;
            }
            if (located.equity === undefined) record.blankEquity = true;
            institutions.push(record);
            byName.set(name.toLowerCase(), record);
        }
        if (!errors.length && institutions.length < 2) fail(institutionsName, null, null, 'At least two institutions are needed to model contagion.');
        if (institutions.length > maximumInstitutions) fail(institutionsName, null, null, `${institutions.length} institutions is more than this version handles (at most ${maximumInstitutions}).`);
    }

    // ---- exposures -----------------------------------------------------------------------------------
    let matrix = null;
    let exposuresEstimated = false;
    if (!errors.length && exposuresFile) {
        const parsedExposures = parseCsv(exposuresFile.text);
        const columns = locateColumns(parsedExposures.header, exposureColumns);
        for (const key of ['lender', 'borrower', 'amount']) {
            if (columns[key] === undefined) fail(exposuresName, 1, canonicalNames[key], `The column "${canonicalNames[key]}" is missing. Headings found: ${parsedExposures.header.join(', ') || 'none'}.`);
        }
        const exposuresDecimal = columns.amount === undefined ? '.' : detectDecimalSeparator(parsedExposures.rows.map(({ values }) => values[columns.amount]));
        for (const note of readingNotes(exposuresName, exposuresFile, parsedExposures, exposuresDecimal)) warn(exposuresName, null, note);
        if (!errors.length) {
            const size = institutions.length;
            const index = new Map(institutions.map((record, position) => [record.name.toLowerCase(), position]));
            matrix = Array.from({ length: size }, () => new Array(size).fill(0));
            const seen = new Map();
            for (const { line, values } of parsedExposures.rows) {
                const lender = index.get(String(values[columns.lender] ?? '').trim().toLowerCase());
                const borrower = index.get(String(values[columns.borrower] ?? '').trim().toLowerCase());
                if (lender === undefined) { fail(exposuresName, line, 'lender', `"${String(values[columns.lender]).trim()}" is not in the institutions file.`); continue; }
                if (borrower === undefined) { fail(exposuresName, line, 'borrower', `"${String(values[columns.borrower]).trim()}" is not in the institutions file.`); continue; }
                if (lender === borrower) { fail(exposuresName, line, 'borrower', `${institutions[lender].name} cannot lend to itself.`); continue; }
                const amount = parseNumber(values[columns.amount], exposuresDecimal);
                if (amount.blank || amount.invalid) { fail(exposuresName, line, 'amount', `"${values[columns.amount] ?? ''}" is not a number.`); continue; }
                if (!(amount.value > 0)) { fail(exposuresName, line, 'amount', `The amount must be more than zero (found ${format(amount.value)}).`); continue; }
                const key = `${lender}:${borrower}`;
                if (seen.has(key)) warn(exposuresName, line, `${institutions[lender].name} to ${institutions[borrower].name} is listed again (first on line ${seen.get(key)}); the amounts are added.`);
                else seen.set(key, line);
                matrix[lender][borrower] += amount.value;
            }
            if (!errors.length) {
                institutions.forEach((record, position) => {
                    const lent = matrix[position].reduce((total, value) => total + value, 0);
                    const borrowed = matrix.reduce((total, row) => total + row[position], 0);
                    const check = (declared, actual, column, verb) => {
                        if (declared !== undefined && Math.abs(declared - actual) > Math.max(1, 0.005 * Math.max(declared, actual))) {
                            fail(institutionsName, record.line, column, `${record.name}: ${column} is ${format(declared)} but ${exposuresName} shows ${verb} ${format(actual)}.`);
                        }
                    };
                    check(record.interbankAssets, lent, 'interbank_assets', 'lending');
                    check(record.interbankLiabilities, borrowed, 'interbank_liabilities', 'borrowing');
                    record.interbankAssets = lent;
                    record.interbankLiabilities = borrowed;
                });
            }
        }
    } else if (!errors.length) {
        // No matrix: estimate it from the totals, if both are given.
        if (hasInterbankAssetsColumn && hasInterbankLiabilitiesColumn) {
            for (const record of institutions) {
                record.interbankAssets ??= 0;
                record.interbankLiabilities ??= 0;
            }
            const totalAssets = institutions.reduce((total, record) => total + record.interbankAssets, 0);
            const totalLiabilities = institutions.reduce((total, record) => total + record.interbankLiabilities, 0);
            if (totalAssets > 0 && totalLiabilities > 0) {
                if (Math.abs(totalAssets - totalLiabilities) > 0.01 * Math.max(totalAssets, totalLiabilities)) {
                    warn(institutionsName, null, `Interbank assets total ${format(totalAssets)} but interbank liabilities total ${format(totalLiabilities)}; liabilities are scaled to match for the estimate, and each institution's own figure is kept for its balance sheet check.`);
                }
                const scale = totalAssets / totalLiabilities;
                const estimated = estimateExposures(institutions.map((record) => record.interbankAssets), institutions.map((record) => record.interbankLiabilities * scale));
                matrix = estimated;
                exposuresEstimated = true;
                warn(exposuresName, null, `No exposures file was given, so bilateral exposures are estimated from each institution's interbank totals (proportional allocation${institutions.length - 1 > estimatedCounterpartyLimit ? `, keeping each institution's ${estimatedCounterpartyLimit} largest counterparties in each direction` : ''}). Treat contagion results as indicative, and supply real exposures when you have them.`);
            }
        } else {
            for (const record of institutions) { record.interbankAssets ??= 0; record.interbankLiabilities ??= 0; }
            warn(institutionsName, null, 'No exposures file and no interbank totals were given, so the institutions are modelled with no interbank links; only depositor runs and asset-price shocks will spread stress.');
        }
    }

    // ---- balance sheets ------------------------------------------------------------------------------
    // Checked for every row whose numbers parsed, even when other rows have problems, so one pass shows
    // the user everything wrong with the file instead of one batch at a time.
    if (institutions.length) {
        for (const record of institutions) {
            if (record.invalid) continue;
            record.interbankAssets ??= 0;
            record.interbankLiabilities ??= 0;
            const assets = record.cash + record.loans + record.interbankAssets;
            if (record.blankEquity) {
                record.equity = assets - record.deposits - record.interbankLiabilities;
                if (!(record.equity > 0)) {
                    fail(institutionsName, record.line, 'equity', `${record.name}: with no equity given, the balancing figure is ${format(record.equity)}, so assets (${format(assets)}) do not exceed liabilities (${format(record.deposits + record.interbankLiabilities)}). The institution would already be insolvent.`);
                } else warn(institutionsName, record.line, `${record.name}: equity was blank, so it is taken as the balancing figure, ${format(record.equity)}.`);
            } else {
                const liabilities = record.deposits + record.interbankLiabilities + record.equity;
                const gap = assets - liabilities;
                if (Math.abs(gap) > Math.max(balanceTolerance.absolute, balanceTolerance.relative * assets)) {
                    fail(institutionsName, record.line, 'balance sheet', `${record.name}: assets ${format(assets)} do not equal liabilities and equity ${format(liabilities)} (difference ${format(gap)}). Check the figures, or leave equity blank to have it computed.`);
                }
            }
            record.assets = assets;
        }
    }

    const summary = errors.length ? null : {
        institutions: institutions.length,
        exposures: matrix ? matrix.flat().filter((value) => value > 0).length : 0,
        exposuresEstimated,
        totalAssets: institutions.reduce((total, record) => total + record.assets, 0),
        totalEquity: institutions.reduce((total, record) => total + record.equity, 0),
        totalInterbank: institutions.reduce((total, record) => total + record.interbankAssets, 0)
    };
    const preview = institutions.map((record) => ({
        name: record.name, assets: record.assets ?? null, equity: record.equity ?? null,
        equityRatio: record.assets ? record.equity / record.assets : null,
        interbankAssets: record.interbankAssets ?? 0, interbankLiabilities: record.interbankLiabilities ?? 0
    }));
    // Problems in the order the user meets them in their spreadsheet.
    errors.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
    if (errors.length) return { ok: false, report: { errors, warnings, summary, institutions: preview } };

    // ---- build the model -----------------------------------------------------------------------------
    const read = (path) => helpers.readPackageJson(path);
    const [bankTemplate, walletsTemplate, centralBankTemplate, marketTemplate] = await Promise.all(
        ['commercialBank', 'depositorWallets', 'centralBank', 'assetMarket'].map((id) => read(`bundles/${id}.json`)));
    const bundles = Object.fromEntries(await Promise.all(
        ['depositRun', 'fireSale', 'interbankLendingScaled', 'interbankDefault', 'emergencyLending'].map(async (id) => [id, await read(`bundles/${id}.json`)])));

    const builder = new NetworkBuilder(helpers);
    const size = institutions.length;
    const radius = 5 + 0.7 * size;
    const stateValues = (record) => ({ reserves: record.cash, loans: record.loans, claims: record.interbankAssets, deposits: record.deposits, equity: record.equity, borrowing: record.interbankLiabilities });
    const nodeFor = (template, name, position, initial = {}) => builder.node({
        name, type: template.name, position, shape: template.shape, color: template.color,
        states: template.states.map((state) => ({ symbol: state.symbol, label: state.label, initialValue: initial[state.symbol] ?? state.initialValue, unit: state.unit }))
    });
    const totalDeposits = institutions.reduce((total, record) => total + record.deposits, 0);
    const totalLoans = institutions.reduce((total, record) => total + record.loans, 0);
    const bankNodes = institutions.map((record, position) => {
        const angle = (2 * Math.PI * position) / size;
        return nodeFor(bankTemplate, record.name, [Number((radius * Math.cos(angle)).toFixed(3)), Number((radius * Math.sin(angle)).toFixed(3)), 0], stateValues(record));
    });
    const wallets = nodeFor(walletsTemplate, 'Depositor wallets', [0, 0, -3]);
    const centralBank = nodeFor(centralBankTemplate, 'Central bank', [0, 0, 4], { reserves: assumptions.centralBankShareOfDeposits * totalDeposits });
    const market = nodeFor(marketTemplate, 'Asset market', [0, 0, 8], { cash: assumptions.marketCashShareOfLoans * totalLoans, holdings: 0 });

    // Market-wide constants come from the bundles; only the market depth is scaled to the data.
    const parameterIndex = [];
    const globalShared = new Map();
    const noteGlobal = (key, shared, label) => {
        if (globalShared.has(shared.id)) return;
        globalShared.set(shared.id, true);
        parameterIndex.push({ key, scope: 'global', sharedParameterId: shared.id, name: shared.name, symbol: shared.symbol, value: shared.value, live: shared.mode === 'live', minimum: shared.control?.minimum ?? null, maximum: shared.control?.maximum ?? null, label });
    };

    institutions.forEach((record, position) => {
        const bank = bankNodes[position];
        const fragment = symbolFragment(record.name);
        // Stress begins when reserves fall below the institution's target. The target is 10% of its
        // deposits, but never more than what it holds now: an institution already below 10% would
        // otherwise start the model in distress with no shock applied.
        const wantedTarget = assumptions.reserveTargetShareOfDeposits * record.deposits;
        if (record.cash < wantedTarget) warnings.push({ file: institutionsName, line: record.line, message: `${record.name} holds ${format(record.cash)} in cash and reserves, less than ${assumptions.reserveTargetShareOfDeposits * 100}% of its deposits (${format(wantedTarget)}), so its reserve target is set to what it holds now.` });
        const reserveTarget = builder.sharedParameter({ symbol: `reserveTarget${fragment}`, name: `Reserve target (${record.name})`, value: Number(Math.min(wantedTarget, record.cash).toFixed(2)), unit: 'M' });
        const withdrawal = builder.sharedParameter({
            symbol: `withdrawalRate${fragment}`, name: `Withdrawal rate (${record.name})`, value: 0, unit: '1/day',
            live: { minimum: 0, maximum: assumptions.withdrawalRateMaximum, step: 0.005 }
        });
        parameterIndex.push({ key: 'withdrawalRate', scope: 'institution', entity: record.name, sharedParameterId: withdrawal.id, name: withdrawal.name, symbol: withdrawal.symbol, value: 0, live: true, minimum: 0, maximum: assumptions.withdrawalRateMaximum });
        const runShared = builder.applyBundle(bundles.depositRun, { bank, wallets }, { bind: { reserveTarget, withdrawalRate: withdrawal }, label: record.name });
        noteGlobal('panicSensitivity', runShared.get('panicSensitivity'), 'Panic sensitivity');
        const saleShared = builder.applyBundle(bundles.fireSale, { bank, market }, { bind: { reserveTarget }, label: record.name });
        for (const key of ['fireSaleRate', 'baseHaircut', 'priceImpact']) noteGlobal(key, saleShared.get(key), key);
        const lendingMaximum = Number((assumptions.emergencyLendingShareOfDepositsPerDay * record.deposits).toFixed(2));
        const emergency = builder.sharedParameter({
            symbol: `emergencyLending${fragment}`, name: `Emergency lending (${record.name})`, value: 0, unit: 'M/day',
            live: { minimum: 0, maximum: lendingMaximum, step: Number((lendingMaximum / 100).toPrecision(2)) }
        });
        parameterIndex.push({ key: 'emergencyLending', scope: 'institution', entity: record.name, sharedParameterId: emergency.id, name: emergency.name, symbol: emergency.symbol, value: 0, live: true, minimum: 0, maximum: lendingMaximum });
        builder.applyBundle(bundles.emergencyLending, { centralBank, bank }, { bind: { lending: emergency }, label: record.name });
    });

    // The market depth scales with the loan book: 1.2 / total loans reproduces the reference model's calibration.
    const priceImpact = builder.sharedParameters.find((shared) => shared.symbol === 'priceImpact');
    if (priceImpact) {
        builder.patchSharedParameter(priceImpact, { value: Number((1 / (assumptions.marketDepthShareOfLoans * totalLoans)).toPrecision(4)) });
        parameterIndex.find((entry) => entry.key === 'priceImpact').value = priceImpact.value;
    }

    // Interbank links follow the exposures. Lending can flow either way along a link (whichever side
    // holds more reserves lends), and a borrower's default is charged to each creditor by the share of
    // its interbank debt that creditor holds.
    if (matrix) {
        const linked = new Set();
        for (let lender = 0; lender < size; lender += 1) for (let borrower = 0; borrower < size; borrower += 1) {
            if (matrix[lender][borrower] > 0) { linked.add(`${lender}:${borrower}`); linked.add(`${borrower}:${lender}`); }
        }
        for (const key of linked) {
            const [lender, borrower] = key.split(':').map(Number);
            const shared = builder.applyBundle(bundles.interbankLendingScaled, { lender: bankNodes[lender], borrower: bankNodes[borrower] }, { label: `${institutions[lender].name} to ${institutions[borrower].name}` });
            noteGlobal('flowRate', shared.get('flowRate'), 'flowRate');
        }
        for (let lender = 0; lender < size; lender += 1) for (let borrower = 0; borrower < size; borrower += 1) {
            if (!(matrix[lender][borrower] > 0)) continue;
            const share = matrix[lender][borrower] / institutions[borrower].interbankLiabilities;
            const creditShare = builder.sharedParameter({
                symbol: `creditShare${symbolFragment(institutions[lender].name)}To${symbolFragment(institutions[borrower].name)}`,
                name: `Credit share (${institutions[lender].name} in ${institutions[borrower].name})`, value: Number(share.toPrecision(6))
            });
            const used = builder.applyBundle(bundles.interbankDefault, { borrower: bankNodes[borrower], creditor: bankNodes[lender] }, { bind: { creditShare }, label: `${institutions[borrower].name} owes ${institutions[lender].name}` });
            noteGlobal('writeDownRate', used.get('writeDownRate'), 'writeDownRate');
        }
    }

    const document = builder.document({ globalTimeStep: 0.1, outputInterval: 0.5 });
    return {
        ok: true,
        document,
        parameterIndex,
        report: {
            errors: [], warnings, summary, institutions: preview,
            assumptions: {
                'Reserve target': `${assumptions.reserveTargetShareOfDeposits * 100}% of each institution's deposits, or its current reserves if lower`,
                'Central bank reserves': `${assumptions.centralBankShareOfDeposits * 100}% of total deposits`,
                'Asset market depth': `${assumptions.marketDepthShareOfLoans * 100}% of total loans`,
                'Interbank default': exposuresEstimated ? 'shares from estimated exposures' : 'shares from the exposures file'
            }
        }
    };
}
