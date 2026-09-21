/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fitSameBar, preferTogetherDirection, yahooChartToCsv, alignSeries, analyzeWindows, inferenceCsv, linkStability, parseSeriesFile, rollingWindows, skeletonThresholdFor, stabilityLabel, toChanges } from '../../packages/toolbox/lib/market.mjs';

const stooq = 'Date,Open,High,Low,Close,Volume\n2026-01-02,10,11,9,10.5,100\n2026-01-05,10.5,12,10,11.0,120\n2026-01-06,11,12,10,10.8,90\n2026-01-07,10.8,11,10,11.4,95\n';
const fred = 'observation_date,DGS10\n2026-01-02,4.10\n2026-01-05,.\n2026-01-06,4.05\n2026-01-07,4.20\n';

test('a Stooq price file reads the Close column and a FRED file skips its missing markers', () => {
    const price = parseSeriesFile(stooq, 'Oil');
    assert.deepEqual(price.points.map((point) => point.value), [10.5, 11, 10.8, 11.4]);
    const rate = parseSeriesFile(fred, 'Ten-year');
    assert.equal(rate.points.length, 3);
    assert.deepEqual(rate.dropped, [{ line: 3, reason: 'no value' }]);
});

test('files newest-first, with day-first dates and decimal commas, are read the same way', () => {
    const european = 'Datum;Schluss\n30.01.2026;1.234,5\n29.01.2026;1.200,0\n28.01.2026;1.190,25\n';
    const series = parseSeriesFile(european, 'DAX');
    assert.deepEqual(series.points, [{ date: '2026-01-28', value: 1190.25 }, { date: '2026-01-29', value: 1200 }, { date: '2026-01-30', value: 1234.5 }]);
});

test('a file with no usable rows says so instead of returning an empty series', () => {
    assert.throws(() => parseSeriesFile('Date,Close\nnot a date,5\n', 'Bad'), /fewer than two usable rows/);
});

test('alignment keeps shared dates only and reports what each series lost', () => {
    const aligned = alignSeries([parseSeriesFile(stooq, 'Oil'), parseSeriesFile(fred, 'Ten-year')]);
    assert.deepEqual(aligned.dates, ['2026-01-02', '2026-01-06', '2026-01-07']);
    assert.deepEqual(aligned.lost, [{ name: 'Oil', lost: 1, of: 4 }, { name: 'Ten-year', lost: 0, of: 3 }]);
    assert.throws(() => alignSeries([parseSeriesFile(stooq, 'Oil')]), /at least two/);
    assert.throws(() => alignSeries([parseSeriesFile(stooq, 'Oil'), parseSeriesFile(stooq, 'Oil')]), /same name/);
});

test('prices become log returns and rates, which stay positive here but can cross zero, become differences when they do', () => {
    const rates = 'Date,Value\n2026-01-02,0.5\n2026-01-05,-0.1\n2026-01-06,0.2\n2026-01-07,0.3\n';
    const changes = toChanges(alignSeries([parseSeriesFile(stooq, 'Oil'), parseSeriesFile(rates, 'Spread')]));
    assert.deepEqual(changes.kinds, ['log return', 'difference']);
    assert.ok(Math.abs(changes.columns[0][0] - Math.log(11 / 10.5)) < 1e-12);
    assert.ok(Math.abs(changes.columns[1][0] - -0.6) < 1e-12);
    assert.equal(changes.dates.length, 3);
});

test('the inference table numbers the bars, so weekends and holidays leave no gaps', () => {
    const changes = { names: ['Brent crude', 'S&P 500'], dates: ['a', 'b', 'c'], columns: [[0.1, 0.2, 0.3], [1, 2, 3]] };
    assert.equal(inferenceCsv(changes), 'time,Brent_crude,S_P_500\n0,0.1,1\n1,0.2,2\n2,0.3,3\n');
    assert.equal(inferenceCsv(changes, 1, 3), 'time,Brent_crude,S_P_500\n0,0.2,2\n1,0.3,3\n');
});

test('windows end at the latest bar, step back, and refuse a window longer than the data', () => {
    assert.deepEqual(rollingWindows(100, { length: 60, count: 3, step: 10 }), [{ from: 40, to: 100 }, { from: 30, to: 90 }, { from: 20, to: 80 }]);
    assert.deepEqual(rollingWindows(100, { length: 40, count: 5 }), [{ from: 60, to: 100 }, { from: 20, to: 60 }], 'By default windows do not overlap.');
    assert.equal(rollingWindows(100, { length: 60, count: 10, step: 20 }).length, 3, 'Windows stop when they would run off the start.');
    assert.throws(() => rollingWindows(50, { length: 60 }), /only 50 are available/);
});

const edge = (source, target, lag, coefficient, score = 0.1) => ({ sourceColumn: source, targetColumn: target, lag, terms: [{ degree: 1, coefficient }], score, provenance: 'continuousLagged' });

test('stability counts appearances, sign and lag agreement, and orders the steadiest links first', () => {
    const reports = [
        { edges: [edge('Oil', 'Airlines', 2, -0.3), edge('Gold', 'Miners', 1, 0.2)] },
        { edges: [edge('Oil', 'Airlines', 2, -0.25)] },
        { edges: [edge('Oil', 'Airlines', 2, -0.35), edge('Gold', 'Miners', 1, -0.2)] },
        { edges: [edge('Oil', 'Airlines', 2, -0.3)] },
        { edges: [edge('Oil', 'Airlines', 3, -0.3)] }
    ];
    const [oil, gold] = linkStability(reports);
    assert.equal(oil.source, 'Oil');
    assert.equal(oil.share, 1);
    assert.equal(oil.signAgreement, 1);
    assert.equal(oil.lag, 2);
    assert.equal(oil.lagAgreement, 0.8);
    assert.equal(stabilityLabel({ ...oil, windows: 5 }), 'stable');
    assert.equal(gold.share, 0.4);
    assert.equal(gold.latest, true, 'The link is present in the newest window, though it flips sign.');
    assert.equal(gold.signAgreement, 0.5);
    assert.equal(stabilityLabel({ ...gold, windows: 5 }), 'unstable');
    assert.equal(stabilityLabel({ ...oil, windows: 2 }), 'too few windows to say');
});

test('pairs that only move together in the same bar are counted apart from lead-lag links', () => {
    const reports = [{ edges: [edge('Oil', 'Airlines', 1, 0.3), { ...edge('Noise', 'Gold', 0, 0.1), provenance: 'correlationOnly' }] }];
    const [only, ...rest] = linkStability(reports);
    assert.equal(only.source, 'Oil');
    assert.equal(rest.length, 0);
    const together = linkStability(reports, 'together');
    assert.deepEqual(together.map((link) => [link.kind, link.source, link.target]), [['together', 'Noise', 'Gold']]);
});

test('of the two directions of a same-bar pair, the one into the more volatile series is preferred', () => {
    const together = (source, target) => ({ source, target });
    const sd = { Gold: 0.01, Miners: 0.02, Alone: 0.03, Other: 0.01 };
    const links = preferTogetherDirection([together('Gold', 'Miners'), together('Miners', 'Gold'), together('Alone', 'Other')], (name) => sd[name]);
    assert.deepEqual(links.map((link) => link.preferred), [true, false, true], 'A pair with one direction only is kept as it is.');
});

test('the skeleton threshold rises to two standard errors on a short window and never drops below the default', () => {
    assert.equal(skeletonThresholdFor(100), 0.2);
    assert.equal(skeletonThresholdFor(1000), 0.1);
});

test('analysing windows sends each window to the analysis and returns the dates it covered', async () => {
    const dates = Array.from({ length: 40 }, (_, index) => `2026-02-${String(index + 1).padStart(2, '0')}`).map((date, index) => (index < 28 ? date : `2026-03-${String(index - 27).padStart(2, '0')}`));
    const changes = { names: ['A', 'B'], dates, columns: [dates.map((_, index) => index), dates.map((_, index) => -index)], kinds: ['difference', 'difference'] };
    const sent = [];
    const result = await analyzeWindows(changes, { length: 20, count: 3, step: 5 }, async (csv, config) => { assert.equal(config.skeletonThreshold, 0.447); sent.push(csv.split('\n').length - 2); return { edges: [edge('A', 'B', 1, 0.5)], selfTerms: [] }; });
    assert.deepEqual(sent, [20, 20, 20]);
    assert.equal(result.windows.length, 3);
    assert.equal(result.overlapping, true);
    assert.equal(result.windows[0].to, dates[39]);
    assert.equal(result.links[0].label, 'stable');
});

test("Yahoo Finance's chart answer reads as a price series, using adjusted closes and skipping empty bars", () => {
    const answer = { chart: { result: [{ meta: { gmtoffset: -14400 }, timestamp: [1789750200, 1789836600, 1789923000], indicators: { adjclose: [{ adjclose: [101.5, null, 103.25] }], quote: [{ close: [100, 101, 102] }] } }], error: null } };
    const series = parseSeriesFile(JSON.stringify(answer), 'SPY');
    assert.deepEqual(series.points.map((point) => point.value), [101.5, 103.25]);
    assert.match(series.points[0].date, /^2026-09-/);
    assert.throws(() => parseSeriesFile(JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }), 'XXXX'), /No data found/);
    assert.throws(() => parseSeriesFile(JSON.stringify({ chart: { result: [{ meta: {} }] } }), 'X'), /holds no prices/);
    assert.equal(yahooChartToCsv(JSON.stringify(answer), 'SPY').split('\n').length, 4);
});

test('a web page in place of data is reported as that, not as a parsing failure', () => {
    assert.throws(() => parseSeriesFile('<!DOCTYPE html><html><body>Please enable JavaScript</body></html>', 'SPY'), /returned a web page/);
});

test('intraday bars keep their time of day, so a day of them is many rows, not one', () => {
    const csv = 'Date,Close\n2026-09-18 09:30:00,10\n2026-09-18 09:35:00,11\n2026-09-18 09:40:00,12\n2026-09-19 00:00:00,13\n19/09/2026 09:30,14\n';
    const series = parseSeriesFile(csv, 'X');
    assert.deepEqual(series.points.map((point) => point.date), ['2026-09-18 09:30', '2026-09-18 09:35', '2026-09-18 09:40', '2026-09-19 00:00', '2026-09-19 09:30']);
    const answer = { chart: { result: [{ meta: { gmtoffset: 3600, dataGranularity: '5m' }, timestamp: [1789723800, 1789724100, 1789724400], indicators: { quote: [{ close: [1, 2, 3] }] } }], error: null } };
    const intraday = parseSeriesFile(JSON.stringify(answer), 'Y');
    assert.equal(intraday.points.length, 3);
    assert.match(intraday.points[0].date, /^2026-09-\d\d \d\d:\d\d$/);
});

test('a midnight bar is kept in an intraday file and dropped from a daily one', () => {
    const intraday = parseSeriesFile('Date,Close\n2026-09-18 00:00,1\n2026-09-18 01:00,2\n2026-09-18 02:00,3\n', 'H');
    assert.equal(intraday.points[0].date, '2026-09-18 00:00');
    const daily = parseSeriesFile('Date,Close\n2026-09-17 00:00:00,1\n2026-09-18 00:00:00,2\n', 'D');
    assert.deepEqual(daily.points.map((point) => point.date), ['2026-09-17', '2026-09-18']);
});

test('hourly bars are named by their hour, so a stock opening at half past lines up with a future on the hour', () => {
    const chart = (offsetSeconds) => JSON.stringify({ chart: { result: [{ meta: { gmtoffset: 0, dataGranularity: '1h' }, timestamp: [1789723800 + offsetSeconds, 1789727400 + offsetSeconds, 1789731000 + offsetSeconds], indicators: { quote: [{ close: [1, 2, 3] }] } }], error: null } });
    const stock = parseSeriesFile(chart(0), 'Stock');
    const future = parseSeriesFile(chart(-1800), 'Future');
    assert.deepEqual(stock.points.map((point) => point.date), future.points.map((point) => point.date));
    assert.match(stock.points[0].date, /^2026-09-\d\d \d\d:00$/);
});

test('a same-bar link is refitted against only the sources kept: one source gives its plain beta, two give their joint effects', () => {
    let seed = 99;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
    const market = Array.from({ length: 400 }, () => normal());
    const sector = market.map((value) => 0.8 * value + 0.6 * normal());
    const target = market.map((value, index) => 0.5 * value + 0.4 * sector[index] + 0.3 * normal());
    const columns = [market, sector, target];
    const slope = (x, y) => { const mx = x.reduce((a, b) => a + b, 0) / x.length; const my = y.reduce((a, b) => a + b, 0) / y.length; return x.reduce((sum, v, i) => sum + (v - mx) * (y[i] - my), 0) / x.reduce((sum, v) => sum + (v - mx) ** 2, 0); };
    const [alone] = fitSameBar(columns, 2, [0], 400);
    assert.ok(Math.abs(alone - slope(market, target)) < 1e-6, 'With one source the coefficient is the plain regression slope, which includes what runs through the sector.');
    assert.ok(alone > 0.75, 'The plain slope on the market is larger than its direct 0.5, since the sector carries part of it.');
    const [direct, viaSector] = fitSameBar(columns, 2, [0, 1], 400);
    assert.ok(Math.abs(direct - 0.5) < 0.1 && Math.abs(viaSector - 0.4) < 0.1, `Fitted together they recover the direct effects (${direct.toFixed(2)}, ${viaSector.toFixed(2)}).`);
    assert.deepEqual(fitSameBar(columns, 2, [0], 400).length, 1);
    assert.deepEqual(fitSameBar([[1, 2, 3], [1, 2, 3]], 1, [0], 250), [0], 'Too few bars to fit: no effect rather than a made-up one.');
});
