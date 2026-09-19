/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { alignSeries, cropAligned, parseSeriesFile, toChanges } from '../lib/market.mjs';

// The Markets importer runs in two steps. "read" turns the chosen price or rate files into a table of changes and
// says what it repaired or dropped; the window then runs causal inference on rolling windows of that table. "build"
// turns the links the user kept into a Konjugate model that can be run forward from the latest bar.
//
// One bar is one unit of model time. Each series becomes a node with a return that follows the links found in the
// data, and a running price change that accumulates it. Every return also relaxes towards zero, at the rate fitted
// from the data if the analysis found one and at one bar otherwise: without that, a shock to a series with no fitted
// memory would carry on for ever.

const defaultRelaxation = -1;
const shockLimit = 0.5;
const maximumSeries = 40;

const nameOf = (fileName) => String(fileName).replace(/\.[^.]+$/, '').trim() || fileName;

// A fixed-point decimal: a scientific-notation number would be read as a product by the equation parser.
const decimal = (value) => {
    const text = Number(value).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
    return text === '-0' ? '0' : text;
};

// "+ 0.3 x", "- 0.3 x" or "+ 0.3" for a constant, with the sign kept outside the number.
function signedTerm(coefficient, symbol) {
    if (!Number.isFinite(coefficient) || Math.abs(coefficient) < 1e-12) return '';
    const sign = coefficient < 0 ? '-' : '+';
    const magnitude = decimal(Math.abs(coefficient));
    return symbol ? `${sign} ${magnitude} \\cdot ${symbol}` : `${sign} ${magnitude}`;
}
const trimLeadingPlus = (latex) => latex.replace(/^\s*\+ /, '').trim() || '0';

function highestId(value, current = 0) {
    if (Array.isArray(value)) return value.reduce((highest, item) => highestId(item, highest), current);
    if (value && typeof value === 'object') {
        let highest = current;
        for (const [key, item] of Object.entries(value)) highest = key === 'id' && Number.isSafeInteger(item) ? Math.max(highest, item) : highestId(item, highest);
        return highest;
    }
    return current;
}

function readStage(files, { exclude = [], from = null, to = null } = {}) {
    const report = { errors: [], warnings: [], summary: {} };
    const series = [];
    for (const file of files) {
        try {
            const parsed = parseSeriesFile(file.text, nameOf(file.name));
            series.push(parsed);
            if (file.encoding && file.encoding !== 'utf-8') report.warnings.push({ file: file.name, message: `Read as ${file.encoding}, not UTF-8.` });
            if (parsed.dropped.length) report.warnings.push({ file: file.name, message: `${parsed.dropped.length} row${parsed.dropped.length === 1 ? '' : 's'} left out: ${parsed.dropped.slice(0, 3).map((row) => `line ${row.line} (${row.reason})`).join(', ')}${parsed.dropped.length > 3 ? ', and more' : ''}.` });
        } catch (error) {
            report.errors.push({ file: file.name, message: error.message });
        }
    }
    if (report.errors.length) return { ok: false, report };
    // A series the user has switched off is left out before the dates are lined up, so it cannot shorten the others.
    const kept = series.filter((item) => !exclude.includes(item.name));
    series.length = 0;
    series.push(...kept);
    if (series.length < 2) { report.errors.push({ file: '', message: 'Choose at least two files: one series on its own has nothing to be linked to.' }); return { ok: false, report }; }
    if (series.length > maximumSeries) { report.errors.push({ file: '', message: `Choose at most ${maximumSeries} series; ${series.length} were chosen.` }); return { ok: false, report }; }
    let aligned;
    try { aligned = alignSeries(series); } catch (error) { report.errors.push({ file: '', message: error.message }); return { ok: false, report }; }
    const everything = aligned;
    if (from || to) aligned = cropAligned(aligned, from, to);
    if (aligned.dates.length < 40) {
        report.errors.push({ file: '', message: `Only ${aligned.dates.length} dates are shared by every series, and at least 40 are needed. Check that the files cover the same period and calendar.` });
        return { ok: false, report };
    }
    for (const item of aligned.lost.filter((entry) => entry.lost > 0 && entry.lost / entry.of > 0.05)) {
        report.warnings.push({ file: item.name, message: `${item.lost} of ${item.of} rows were left out because another series has no value on those dates.` });
    }
    const changes = toChanges(aligned);
    report.summary = { series: changes.names.length, bars: changes.dates.length, from: aligned.dates[0], to: aligned.dates.at(-1) };
    // The levels of the whole overlap go to the window, which draws the preview and lets the user choose a range; the
    // changes and the model use only the chosen range.
    return {
        ok: true, changes, aligned, report,
        data: { names: everything.names, kinds: toChanges(everything).kinds, dates: everything.dates, columns: everything.columns, lost: everything.lost }
    };
}

// The safe column name the inference used for a series (see inferenceCsv in lib/market.mjs).
const safeName = (name) => name.replace(/[^A-Za-z0-9_.-]+/g, '_');

function buildStage(read, options) {
    const { changes } = read;
    const report = read.report;
    const names = changes.names;
    const bySafe = new Map(names.map((name) => [safeName(name), name]));
    const edges = Array.isArray(options.edges) ? options.edges : [];
    const selfTerms = Array.isArray(options.selfTerms) ? options.selfTerms : [];
    const known = (column) => bySafe.has(column);
    const usableEdges = edges.filter((edge) => known(edge.sourceColumn) && known(edge.targetColumn) && edge.sourceColumn !== edge.targetColumn && Array.isArray(edge.terms));
    if (usableEdges.length < edges.length) report.warnings.push({ file: '', message: `${edges.length - usableEdges.length} link${edges.length - usableEdges.length === 1 ? '' : 's'} named a series that is not in the data and were left out.` });
    const selfRate = new Map();
    for (const term of selfTerms) {
        if (!known(term.targetColumn)) continue;
        if (term.rate < -0.05 && term.rate > -4) selfRate.set(term.targetColumn, term.rate);
        else report.warnings.push({ file: '', message: `${bySafe.get(term.targetColumn)}: the fitted memory (${decimal(term.rate)}) would not settle down, so a return that fades within a bar is used instead.` });
    }

    // Each series is a node on a circle; the shocks come from one node in the middle.
    const symbolFor = (index) => `s${index}`;
    const operations = [];
    const count = names.length;
    const spacing = 3.6;
    const radius = count > 1 ? spacing / (2 * Math.sin(Math.PI / count)) : 0;
    names.forEach((name, index) => {
        const angle = (2 * Math.PI * index) / count;
        const column = safeName(name);
        const latest = changes.columns[index].at(-1);
        // A return starts from its latest observed value only if the data gave it a memory; otherwise it starts at rest.
        const start = selfRate.has(column) ? latest : 0;
        operations.push({ kind: 'addNode', ref: `n${index}`, name, type: 'Market series', position: [radius * Math.cos(angle), radius * Math.sin(angle), 0], shape: 'sphere' });
        operations.push({ kind: 'addState', nodeRef: `n${index}`, ref: `r${index}`, name: 'Return per bar', symbol: 'ret', initialValue: start, unit: '' });
        operations.push({ kind: 'addState', nodeRef: `n${index}`, ref: `p${index}`, name: 'Price change since now', symbol: 'lvl', initialValue: 0, unit: '' });
        operations.push({ kind: 'addSourceTerm', nodeRef: `n${index}`, outputStateRef: `p${index}`, latex: '\\mathrm{ret}' });
        operations.push({ kind: 'addSourceTerm', nodeRef: `n${index}`, outputStateRef: `r${index}`, latex: trimLeadingPlus(signedTerm(selfRate.get(column) ?? defaultRelaxation, '\\mathrm{ret}')) });
    });
    operations.push({ kind: 'addNode', ref: 'shocks', name: 'Shocks', type: 'Shock driver', position: [0, 0, 0], shape: 'cylinder', color: '#c9a34a' });
    operations.push({ kind: 'addState', nodeRef: 'shocks', ref: 'shockState', name: 'Driver', symbol: 'driver', initialValue: 0, unit: '' });
    names.forEach((name, index) => {
        operations.push({ kind: 'addEdge', ref: `shockEdge${index}`, name: `Shock → ${name}`, sourceNodeRef: 'shocks', targetNodeRef: `n${index}`, directionality: 'directed' });
        // The return follows a shock added to it, and can also be held to a path of real returns: with the tracking gain
        // above zero it is pulled towards the driven return at that rate.
        operations.push({ kind: 'addParameter', edgeRef: `shockEdge${index}`, ref: `shockParameter${index}`, name: `Shock to ${name}`, symbol: 'shock', value: 0, unit: 'per bar', mode: 'live' });
        operations.push({ kind: 'addParameter', edgeRef: `shockEdge${index}`, ref: `gainParameter${index}`, name: `Tracking gain for ${name}`, symbol: 'trackGain', value: 0, unit: '1/bar', mode: 'live' });
        operations.push({ kind: 'addParameter', edgeRef: `shockEdge${index}`, ref: `driveParameter${index}`, name: `Driven return for ${name}`, symbol: 'drive', value: 0, unit: 'per bar', mode: 'live' });
        operations.push({ kind: 'setEdgeEquation', edgeRef: `shockEdge${index}`, outputStateRef: `r${index}`, latex: '\\mathrm{shock} + \\mathrm{trackGain} \\cdot \\left(\\mathrm{drive} - \\mathrm{targetRet}\\right)' });
    });
    usableEdges.forEach((edge, index) => {
        const from = names.indexOf(bySafe.get(edge.sourceColumn));
        const to = names.indexOf(bySafe.get(edge.targetColumn));
        const linear = [...edge.terms].sort((a, b) => a.degree - b.degree)
            .map((term) => signedTerm(term.coefficient, term.degree === 1 ? '\\mathrm{sourceRet}' : `\\mathrm{sourceRet}^{${term.degree}}`)).join(' ');
        // The constant in a fitted link is the average drift of the target over the learning window. Carried forward it pushes a
        // series in whatever direction it happened to drift, which is noise, so it is left out unless asked for.
        const latex = trimLeadingPlus(`${linear} ${options.keepIntercepts === true ? signedTerm(edge.intercept, null) : ''}`.trim());
        operations.push({ kind: 'addEdge', ref: `link${index}`, name: `${names[from]} → ${names[to]}`, sourceNodeRef: `n${from}`, targetNodeRef: `n${to}`, directionality: 'directed' });
        operations.push({ kind: 'setEdgeEquation', edgeRef: `link${index}`, outputStateRef: `r${to}`, latex });
    });

    const { document } = options.helpers.applyOperations(operations);
    // The shock parameters become live, project-level ones, so a scenario can change them during a run.
    let nextId = highestId(document) + 1;
    const runConfigurationId = nextId++;
    document.runConfigurations = [{ id: runConfigurationId, name: 'Default', globalTimeStep: 0.1, outputInterval: 1 }];
    document.activeRunConfigurationId = runConfigurationId;
    document.sharedParameters = [];
    const parameterIndex = [];
    const control = { minimum: -shockLimit, maximum: shockLimit, step: 0.01 };
    const gainControl = { minimum: 0, maximum: 20, step: 1 };
    names.forEach((name, index) => {
        const edge = document.edges.find((candidate) => candidate.name === `Shock → ${name}`);
        const make = (parameter, entry) => {
            const shared = { id: nextId++, name: entry.name, symbol: `${parameter.symbol}${symbolFor(index)}`, value: 0, unit: parameter.unit, mode: 'live', control: entry.control };
            document.sharedParameters.push(shared);
            Object.assign(parameter, { sharedParameterId: shared.id, control: entry.control });
            parameterIndex.push({ key: parameter.symbol, scope: 'series', entity: name, sharedParameterId: shared.id, name: shared.name, live: true, minimum: entry.control.minimum, maximum: entry.control.maximum, value: 0 });
        };
        const [shock, gain, drive] = ['shock', 'trackGain', 'drive'].map((symbol) => edge.parameters.find((parameter) => parameter.symbol === symbol));
        make(shock, { name: `Shock to ${name}`, control });
        make(gain, { name: `Tracking gain for ${name}`, control: gainControl });
        make(drive, { name: `Driven return for ${name}`, control });
    });
    report.summary = { ...report.summary, links: usableEdges.length, memory: selfRate.size };
    if (!usableEdges.length) report.warnings.push({ file: '', message: 'No links were kept, so a shock to one series will not reach any other. It will still show its own effect.' });
    return { ok: true, document, parameterIndex, report, data: { links: usableEdges.length } };
}

export default async function importData({ files, helpers, options = {} }) {
    const read = readStage(files.filter((file) => file.role === 'series'), options);
    if (!read.ok) return read;
    if (options.stage === 'build') return buildStage(read, { ...options, helpers });
    return { ok: true, data: read.data, report: read.report };
}
