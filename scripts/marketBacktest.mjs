/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Backtests the link model on real Yahoo Finance data: learn up to a date some bars before the end, replay the real moves of
// the driver series through the model for the bars after it, and compare each followed series with what it really did and
// with a guess of no change. Repeated for several as-of dates, so it is not one lucky or unlucky comparison.
// Usage: node scripts/marketBacktest.mjs [horizon in bars] [symbols separated by commas] [bar size: 1d, 1h or 5m]
// It also scores a market-beta guess (each series' usual beta to the S&P 500 times its real move) when ^GSPC is among the series.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateDir, konjugateModule } from './konjugatePaths.mjs';
import { alignSeries, inferenceCsv, parseSeriesFile, preferTogetherDirection, skeletonThresholdFor, toChanges } from '../packages/toolbox/lib/market.mjs';

const host = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const adapter = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };
const horizon = Number(process.argv[2] ?? 21);
const symbols = (process.argv[3] ?? 'GC=F,GDX,JETS,BZ=F,KBE,^GSPC,^TNX').split(',');
const interval = process.argv[4] ?? '1d';
// Yahoo serves about 729 days of hourly bars and 59 days of five-minute bars.
const firstSecond = interval === '1d' ? 0 : Math.floor(Date.now() / 1000) - (interval === '1h' ? 729 : 59) * 86400;
const series = [];
for (const symbol of symbols) {
    const bytes = await host.fetchAllowed({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${firstSecond}&period2=4102444800&interval=${interval}`, hosts: ['query1.finance.yahoo.com'] });
    series.push(parseSeriesFile(new TextDecoder().decode(bytes), symbol));
}
const aligned = alignSeries(series);
if (aligned.dates.length < 250 + horizon * 13) throw new Error(`Only ${aligned.dates.length} shared bars; the backtest needs at least ${250 + horizon * 13}. Use fewer series or a longer history.`);
console.log(`${aligned.names.length} series, ${aligned.dates.length} bars, ${aligned.dates[0]} to ${aligned.dates.at(-1)}`);
const files = aligned.names.map((name, index) => ({ role: 'series', name: `${name}.csv`, text: `Date,Close\n${aligned.dates.map((date, row) => `${date},${aligned.columns[index][row]}`).join('\n')}\n`, encoding: 'utf-8' }));
const addonDirectory = join(fintechRoot, 'packages', 'toolbox');
const importer = { entry: 'importers/marketSeries.mjs' };
const infer = async (csv, config) => (await adapter.inferWithEngine(csv, config, engineOptions)).report;
const safe = (name) => name.replace(/[^A-Za-z0-9_.-]+/g, '_');
const kinds = toChanges(aligned).kinds;
const tally = { scored: 0, closer: 0, side: 0, market: 0, marketScored: 0 };
const marketName = aligned.names.find((name) => name === '^GSPC');
const per = new Map();
for (let back = horizon; back <= horizon * 12; back += horizon) {
    const asOf = aligned.dates.length - 1 - back;
    const to = aligned.dates[asOf];
    const learned = toChanges({ names: aligned.names, dates: aligned.dates.slice(0, asOf + 1), columns: aligned.columns.map((column) => column.slice(0, asOf + 1)) });
    const length = 250;
    const report = await infer(inferenceCsv(learned, learned.dates.length - length), { skeletonThreshold: skeletonThresholdFor(length) });
    const spread = new Map(learned.names.map((name, index) => {
        const column = learned.columns[index].slice(-length);
        const mean = column.reduce((a, b) => a + b, 0) / column.length;
        return [safe(name), Math.sqrt(column.reduce((a, b) => a + (b - mean) ** 2, 0) / column.length)];
    }));
    // Keep what the window would tick by default: every same-bar link into the more volatile series of a pair, and every lead-lag link.
    const together = preferTogetherDirection(report.edges.filter((edge) => edge.provenance === 'correlationOnly').map((edge) => ({ source: edge.sourceColumn, target: edge.targetColumn })), (name) => spread.get(name));
    const preferred = new Set(together.filter((link) => link.preferred).map((link) => `${link.source}|${link.target}`));
    const edges = report.edges.filter((edge) => edge.provenance !== 'correlationOnly' || preferred.has(`${edge.sourceColumn}|${edge.targetColumn}`));
    if (!edges.length) { console.log(`${to}: no links kept`); continue; }
    const built = await host.runImporter({ addonDirectory, importer, files, options: { stage: 'build', to, edges, selfTerms: report.selfTerms, keepIntercepts: process.env.KEEP_INTERCEPTS === '1' } });
    const drivers = [...new Set(edges.map((edge) => aligned.names.find((name) => safe(name) === edge.sourceColumn)))];
    const content = JSON.stringify(built.document);
    const configuration = built.document.runConfigurations[0];
    const config = { name: 'Baseline', targetTime: horizon, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
    const start = await adapter.startEngineRun(content, config, engineOptions, { retainResult: true });
    const baseline = { result: await start.completion, cleanup: start.cleanup };
    const actualBar = (name, k) => {
        const column = aligned.columns[aligned.names.indexOf(name)];
        return kinds[aligned.names.indexOf(name)] === 'log return' ? Math.log(column[asOf + k + 1] / column[asOf + k]) : column[asOf + k + 1] - column[asOf + k];
    };
    const samples = Object.fromEntries(drivers.map((name) => [name, Array.from({ length: horizon }, (_, k) => actualBar(name, k)).flatMap((value, k) => [[k + 0.001, value], [k + 0.999, value]])]));
    const scenario = { scenarioId: 'replay', name: 'Replay', forkAt: 0, runTime: horizon, interventions: [{ parameter: 'trackGain', target: 'supplied', value: 15 }, { parameter: 'drive', target: 'supplied', samples: true }] };
    const interventions = host.resolveInterventions(scenario, built.parameterIndex, null, { entities: drivers, samples });
    const { child } = await host.runScenarioBranches({ content, config, scenario, interventions, baseline, engineOptions });
    for (const [index, name] of aligned.names.entries()) {
        if (drivers.includes(name)) continue;
        const node = built.document.nodes.find((item) => item.name === name);
        const lvl = child.result.samples.at(-1).states.find((item) => item.stateId === node.states.find((state) => state.symbol === 'lvl').id).value;
        const price = kinds[index] === 'log return';
        const simulated = price ? 100 * (Math.exp(lvl) - 1) : lvl;
        const total = Array.from({ length: horizon }, (_, k) => actualBar(name, k)).reduce((a, b) => a + b, 0);
        const actual = price ? 100 * (Math.exp(total) - 1) : total;
        if (Math.abs(simulated) < (price ? 0.05 : 0.005)) continue;
        let marketNote = '';
        if (marketName && name !== marketName && price && kinds[aligned.names.indexOf(marketName)] === 'log return') {
            const y = learned.columns[index].slice(-length);
            const x = learned.columns[learned.names.indexOf(marketName)].slice(-length);
            const mx = x.reduce((a, b) => a + b, 0) / x.length;
            const my = y.reduce((a, b) => a + b, 0) / y.length;
            const beta = x.reduce((sum, value, i) => sum + (value - mx) * (y[i] - my), 0) / (x.reduce((sum, value) => sum + (value - mx) ** 2, 0) || 1);
            const marketTotal = Array.from({ length: horizon }, (_, k) => actualBar(marketName, k)).reduce((a, b) => a + b, 0);
            const guess = 100 * (Math.exp(beta * marketTotal) - 1);
            tally.marketScored += 1;
            const modelBeats = Math.abs(actual - simulated) < Math.abs(actual - guess);
            if (modelBeats) tally.market += 1;
            marketNote = `, market guess ${guess.toFixed(2)} (${modelBeats ? 'model closer' : 'market closer'})`;
        }
        tally.scored += 1;
        const closer = Math.abs(actual - simulated) < Math.abs(actual);
        if (closer) tally.closer += 1;
        if (Math.sign(actual) === Math.sign(simulated)) tally.side += 1;
        const entry = per.get(name) ?? { n: 0, closer: 0 };
        entry.n += 1;
        if (closer) entry.closer += 1;
        per.set(name, entry);
        console.log(`${to} ${name}: actual ${actual.toFixed(2)}, model ${simulated.toFixed(2)}, ${closer ? 'model closer' : 'no-change closer'}${marketNote}`);
    }
    await baseline.cleanup?.();
    await child.cleanup?.();
}
console.log(`\nOver ${tally.scored} comparisons the model was closer than a guess of no change ${tally.closer} times (${(100 * tally.closer / Math.max(1, tally.scored)).toFixed(0)}%) and had the direction right ${tally.side} times (${(100 * tally.side / Math.max(1, tally.scored)).toFixed(0)}%).`);
if (tally.marketScored) console.log(`Against the ${marketName} beta guess the model was closer ${tally.market} of ${tally.marketScored} times (${(100 * tally.market / tally.marketScored).toFixed(0)}%).`);
for (const [name, entry] of per) console.log(`  ${name}: closer ${entry.closer} of ${entry.n}`);
