/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { detectDecimalSeparator, normalizeHeading, parseCsv, parseLocalizedNumber } from './csv.mjs';

// Reads price or rate files as Stooq, FRED, Yahoo Finance exports and most spreadsheets write them, lines them up
// on shared dates, turns them into changes, and measures how stable the causal links between them are across
// rolling windows. Everything here is pure: the causal analysis itself is passed in as a function, so the same
// code runs against Konjugate's engine in the window and against a stand-in in the tests.

const dateHeadings = ['date', 'observationdate', 'time', 'timestamp', 'datetime', 'day'];
const valueHeadings = ['adjclose', 'adjustedclose', 'close', 'closingprice', 'price', 'last', 'value', 'settle', 'rate'];

// Accepts 2026-09-19, 2026-09-19 16:00:00, 19/09/2026, 19.09.2026 and 09/19/2026 (when a first part above 12 rules
// out day-first there is no ambiguity; otherwise the file's own other rows decide, see readDates).
function isoDate(text, dayFirst) {
    const value = String(text ?? '').trim();
    let match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    match = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
    if (match) {
        const [first, second] = [Number(match[1]), Number(match[2])];
        const [day, month] = dayFirst ? [first, second] : [second, first];
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
}

// Day-first unless some row has a first part above 12 in a slash date and none has a second part above 12.
function readDates(cells) {
    let firstAbove = false;
    let secondAbove = false;
    for (const cell of cells) {
        const match = String(cell ?? '').trim().match(/^(\d{1,2})[/.](\d{1,2})[/.]\d{4}/);
        if (!match) continue;
        if (Number(match[1]) > 12) firstAbove = true;
        if (Number(match[2]) > 12) secondAbove = true;
    }
    const dayFirst = firstAbove || !secondAbove;
    return cells.map((cell) => isoDate(cell, dayFirst));
}

// Yahoo Finance's chart answer as the date,close CSV the rest of this reads. Uses the adjusted close (splits and
// dividends taken out) when it is there, and the exchange's own calendar day for each bar.
export function yahooChartToCsv(text, name) {
    let answer;
    try { answer = JSON.parse(text); } catch { throw new Error(`${name}: the answer was not readable.`); }
    if (answer?.chart?.error) throw new Error(`${name}: ${answer.chart.error.description ?? answer.chart.error.code ?? 'the source reported an error'}.`);
    const result = answer?.chart?.result?.[0];
    const stamps = result?.timestamp;
    const values = result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(stamps) || !Array.isArray(values)) throw new Error(`${name}: the answer holds no prices. Check the symbol.`);
    const offset = Number(result.meta?.gmtoffset) || 0;
    const lines = ['Date,Close'];
    stamps.forEach((stamp, index) => {
        if (values[index] === null || values[index] === undefined) return;
        lines.push(`${new Date((stamp + offset) * 1000).toISOString().slice(0, 10)},${values[index]}`);
    });
    return `${lines.join('\n')}\n`;
}

// One file, one series. Returns { name, points: [{ date, value }], dropped: [{ line, reason }] } or throws with a
// message a person can act on.
export function parseSeriesFile(text, name) {
    const trimmed = String(text).trimStart();
    if (trimmed.startsWith('{')) return parseSeriesFile(yahooChartToCsv(trimmed, name), name);
    if (/^<(!doctype|html)/i.test(trimmed)) throw new Error(`${name}: the source returned a web page, not data. It may ask for a browser check. Try another source, or save the file yourself and choose it.`);
    const table = parseCsv(text);
    if (table.header.length < 2) throw new Error(`${name}: expected a date column and a value column.`);
    const headings = table.header.map(normalizeHeading);
    const dateColumn = Math.max(0, headings.findIndex((heading) => dateHeadings.includes(heading)));
    let valueColumn = -1;
    for (const wanted of valueHeadings) {
        valueColumn = headings.indexOf(wanted);
        if (valueColumn >= 0) break;
    }
    if (valueColumn < 0) valueColumn = headings.findIndex((_, index) => index !== dateColumn);
    if (valueColumn === dateColumn) throw new Error(`${name}: could not tell which column holds the values.`);
    const dates = readDates(table.rows.map((row) => row.values[dateColumn]));
    const decimal = detectDecimalSeparator(table.rows.map((row) => row.values[valueColumn]));
    const points = [];
    const dropped = [];
    table.rows.forEach((row, index) => {
        const raw = String(row.values[valueColumn] ?? '').trim();
        if (dates[index] === null) { dropped.push({ line: row.line, reason: `"${row.values[dateColumn]}" is not a date` }); return; }
        if (raw === '' || raw === '.' || /^(null|nan|n\/a|na|-)$/i.test(raw)) { dropped.push({ line: row.line, reason: 'no value' }); return; }
        const value = parseLocalizedNumber(raw, decimal);
        if (!Number.isFinite(value)) { dropped.push({ line: row.line, reason: `"${raw}" is not a number` }); return; }
        points.push({ date: dates[index], value });
    });
    // Newest first, as some sites write them, or out of order: sort, and keep the last value for a repeated date.
    const byDate = new Map();
    for (const point of points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) byDate.set(point.date, point.value);
    const sorted = [...byDate].map(([date, value]) => ({ date, value }));
    if (sorted.length < 2) throw new Error(`${name}: fewer than two usable rows.`);
    return { name, points: sorted, dropped };
}

// Keeps only the dates every series has. Reports how many each series lost, since a series with a different
// calendar (a rate published on business days, a crypto pair every day) silently shrinks the sample otherwise.
export function alignSeries(seriesList) {
    if (seriesList.length < 2) throw new Error('Choose at least two series to look for links between.');
    const names = seriesList.map((series) => series.name);
    if (new Set(names).size !== names.length) throw new Error('Two series have the same name. Rename one of the files.');
    let shared = new Set(seriesList[0].points.map((point) => point.date));
    for (const series of seriesList.slice(1)) {
        const dates = new Set(series.points.map((point) => point.date));
        shared = new Set([...shared].filter((date) => dates.has(date)));
    }
    const dates = [...shared].sort();
    const columns = seriesList.map((series) => {
        const lookup = new Map(series.points.map((point) => [point.date, point.value]));
        return dates.map((date) => lookup.get(date));
    });
    return {
        names, dates, columns,
        lost: seriesList.map((series) => ({ name: series.name, lost: series.points.length - dates.length, of: series.points.length }))
    };
}

// Changes between consecutive bars: log returns for a series that is always positive (a price), plain differences
// otherwise (a rate or spread, which can be zero or negative). Returns one fewer row than the levels.
export function toChanges(aligned) {
    const kinds = aligned.columns.map((column) => (column.every((value) => value > 0) ? 'log return' : 'difference'));
    const columns = aligned.columns.map((column, index) => column.slice(1).map((value, position) => (kinds[index] === 'log return' ? Math.log(value / column[position]) : value - column[position])));
    return { names: aligned.names, dates: aligned.dates.slice(1), columns, kinds };
}

// Konjugate's inference format: a numeric, regularly spaced time column (the bar number, so holidays and weekends
// leave no gaps) and one column per series. Column names are made safe for the format.
export function inferenceCsv(changes, from = 0, to = changes.dates.length) {
    const safe = changes.names.map((name) => name.replace(/[^A-Za-z0-9_.-]+/g, '_'));
    const lines = [['time', ...safe].join(',')];
    for (let row = from; row < to; row += 1) lines.push([row - from, ...changes.columns.map((column) => column[row])].join(','));
    return `${lines.join('\n')}\n`;
}

// Windows of a fixed length ending at the latest bar and stepping back, newest first.
// Windows do not overlap unless asked to (step below the length): overlapping windows share bars, so a link that
// appears in all of them may be one chance correlation counted many times.
export function rollingWindows(total, { length, count = 6, step = length }) {
    if (length > total) throw new Error(`The window is ${length} bars but only ${total} are available. Use a shorter window or more history.`);
    const windows = [];
    for (let end = total; end - length >= 0 && windows.length < count; end -= step) windows.push({ from: end - length, to: end });
    return windows;
}

// The direction of an edge's effect: the sign of its linear coefficient (degree 1), or of the first term.
function edgeSign(edge) {
    const linear = (edge.terms ?? []).find((term) => term.degree === 1) ?? edge.terms?.[0];
    return linear ? Math.sign(linear.coefficient) : 0;
}

// For each source-to-target link found in any window: in how many windows it appeared, whether it kept its sign,
// the lag most windows agreed on, and its typical held-out score. Newest window first, so `latest` says whether
// the link is present in the most recent one.
export function linkStability(reports, kind = 'lagged') {
    const links = new Map();
    reports.forEach((report, windowIndex) => {
        // Lead-lag links (one series' past helps predict another) and same-bar co-movement (provenance
        // "correlationOnly": no time order) are counted apart, since they mean different things and are used differently.
        for (const edge of report.edges.filter((candidate) => (candidate.provenance === 'correlationOnly') === (kind === 'together'))) {
            const key = `${edge.sourceColumn}\u0000${edge.targetColumn}`;
            if (!links.has(key)) links.set(key, { source: edge.sourceColumn, target: edge.targetColumn, seen: [], signs: [], lags: [], scores: [] });
            const link = links.get(key);
            link.seen.push(windowIndex);
            link.signs.push(edgeSign(edge));
            link.lags.push(edge.lag);
            link.scores.push(edge.score);
        }
    });
    const total = reports.length;
    const mode = (values) => {
        const counts = new Map();
        for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
        return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    };
    return [...links.values()].map((link) => {
        const sign = mode(link.signs);
        const lag = mode(link.lags);
        return {
            kind, source: link.source, target: link.target,
            appearances: link.seen.length, windows: total, share: link.seen.length / total,
            latest: link.seen.includes(0),
            sign, signAgreement: link.signs.filter((value) => value === sign).length / link.signs.length,
            lag, lagAgreement: link.lags.filter((value) => value === lag).length / link.lags.length,
            score: link.scores.reduce((sum, value) => sum + value, 0) / link.scores.length
        };
    }).sort((a, b) => b.share - a.share || b.score - a.score);
}

// A plain label for how far to trust a link, from how often it appears and whether it keeps its sign and lag.
export function stabilityLabel(link) {
    if (link.windows < 3) return 'too few windows to say';
    if (link.share >= 0.8 && link.signAgreement >= 0.9 && link.lagAgreement >= 0.8) return 'stable';
    if (link.share >= 0.5 && link.signAgreement >= 0.75) return 'sometimes';
    return 'unstable';
}

// The skeleton threshold the engine uses to decide which pairs are related at all: its default of 0.1 is easily
// exceeded by chance on a short window of noisy returns (a partial correlation from n bars varies by about
// 1/sqrt(n)), so it is raised to two standard errors.
export function skeletonThresholdFor(length) {
    return Math.max(0.1, Number((2 / Math.sqrt(length)).toFixed(3)));
}

// Runs the analysis over each window and summarises. `infer(csv, config)` returns { edges, selfTerms } as the
// launcher's infer call does.
export async function analyzeWindows(changes, { length, count, step }, infer, onProgress = () => {}) {
    const windows = rollingWindows(changes.dates.length, { length, count, step });
    const reports = [];
    for (const [index, window] of windows.entries()) {
        onProgress({ done: index, total: windows.length });
        reports.push(await infer(inferenceCsv(changes, window.from, window.to), { skeletonThreshold: skeletonThresholdFor(window.to - window.from) }));
    }
    onProgress({ done: windows.length, total: windows.length });
    const links = linkStability(reports).map((link) => ({ ...link, label: stabilityLabel(link) }));
    const together = linkStability(reports, 'together').map((link) => ({ ...link, label: stabilityLabel(link) }));
    return { together, overlapping: (step ?? length) < length, windows: windows.map((window) => ({ ...window, from: changes.dates[window.from], to: changes.dates[window.to - 1] })), links, reports };
}

// Same-bar co-movement does not say which series drives which, and the engine reports both directions. Marks one
// direction of each pair as preferred: the one into the more volatile series, which is how a beta is usually read
// (gold miners follow gold, not the reverse). `volatility` maps a column name to its standard deviation.
export function preferTogetherDirection(links, volatility) {
    const byPair = new Map();
    for (const link of links) {
        const key = [link.source, link.target].sort().join('\u0000');
        byPair.set(key, [...(byPair.get(key) ?? []), link]);
    }
    return links.map((link) => {
        const pair = byPair.get([link.source, link.target].sort().join('\u0000'));
        const intoMoreVolatile = (volatility(link.target) ?? 0) >= (volatility(link.source) ?? 0);
        return { ...link, preferred: pair.length === 1 || intoMoreVolatile };
    });
}
