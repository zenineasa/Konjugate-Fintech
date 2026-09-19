/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shocks one series in a model built the way the Markets window builds it (same defaults for the stretches and the links it ticks),
// and prints each other series' response next to a plain regression of it on the shocked series, so chained links that contradict a
// simple regression show up. Needs a network connection.
// Usage: node scripts/marketChain.mjs [shocked series] [symbols separated by commas] [years]
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateDir, konjugateModule } from './konjugatePaths.mjs';
import { alignSeries, analyzeWindows, parseSeriesFile, preferTogetherDirection, toChanges } from '../packages/markets/lib/market.mjs';

const host = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const adapter = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };
const shocked = process.argv[2] ?? '^GSPC';
const symbols = (process.argv[3] ?? 'GC=F,GDX,^GSPC,JETS,KBE,BZ=F').split(',');
const years = Number(process.argv[4] ?? 2);
const from = Math.floor(Date.now() / 1000 - years * 365 * 86400);
const series = [];
for (const symbol of symbols) {
    const bytes = await host.fetchAllowed({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=4102444800&interval=1d`, hosts: ['query1.finance.yahoo.com'] });
    series.push(parseSeriesFile(new TextDecoder().decode(bytes), symbol));
}
const aligned = alignSeries(series);
const changes = toChanges(aligned);
const safe = (name) => name.replace(/[^A-Za-z0-9_.-]+/g, '_');
const infer = async (csv, config) => (await adapter.inferWithEngine(csv, config, engineOptions)).report;
const length = changes.dates.length >= 250 ? 120 : 60;
const analysis = await analyzeWindows(changes, { length, count: 8 }, infer);
const spread = new Map(changes.names.map((name, index) => { const c = changes.columns[index]; const m = c.reduce((a, b) => a + b, 0) / c.length; return [safe(name), Math.sqrt(c.reduce((a, b) => a + (b - m) ** 2, 0) / c.length)]; }));
const together = preferTogetherDirection(analysis.together, (name) => spread.get(name));
const worth = (link) => link.latest && (link.label === 'stable' || link.label === 'sometimes');
const kept = new Set([...analysis.links.filter(worth), ...together.filter((link) => worth(link) && link.preferred)].map((link) => `${link.kind}|${link.source}|${link.target}`));
const edges = analysis.reports[0].edges.filter((edge) => kept.has(`${edge.provenance === 'correlationOnly' ? 'together' : 'lagged'}|${edge.sourceColumn}|${edge.targetColumn}`));
console.log(`${changes.names.length} series, ${changes.dates.length} bars; kept ${edges.length} links: ${edges.map((edge) => `${edge.sourceColumn}>${edge.targetColumn}(${edge.terms[0].coefficient.toFixed(2)})`).join(', ')}`);
const files = aligned.names.map((name, index) => ({ role: 'series', name: `${name}.csv`, text: `Date,Close\n${aligned.dates.map((date, row) => `${date},${aligned.columns[index][row]}`).join('\n')}\n`, encoding: 'utf-8' }));
const addonDirectory = join(fintechRoot, 'packages', 'markets');
const built = await host.runImporter({ addonDirectory, importer: { entry: 'importers/marketSeries.mjs' }, files, options: { stage: 'build', edges, selfTerms: analysis.reports[0].selfTerms, fitBars: 250 } });
const content = JSON.stringify(built.document);
const configuration = built.document.runConfigurations[0];
const config = { name: 'Baseline', targetTime: 21, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
const start = await adapter.startEngineRun(content, config, engineOptions, { retainResult: true });
const baseline = { result: await start.completion, cleanup: start.cleanup };
const scenario = { scenarioId: 'fall', name: 'Fall', forkAt: 1, runTime: 21, interventions: [{ parameter: 'shock', target: 'chosen', value: -0.05, duration: 1 }] };
const interventions = host.resolveInterventions(scenario, built.parameterIndex, shocked);
const { child } = await host.runScenarioBranches({ content, config, scenario, interventions, baseline, engineOptions });
const level = (samples, name) => { const node = built.document.nodes.find((item) => item.name === name); return samples.at(-1).states.find((item) => item.stateId === node.states.find((state) => state.symbol === 'lvl').id).value; };
const x = changes.columns[changes.names.indexOf(shocked)];
console.log(`A 5% fall in ${shocked}, after 21 bars, against a plain regression of each series on it (whole range):`);
for (const [index, name] of changes.names.entries()) {
    const effect = 100 * (Math.exp(level(child.result.samples, name) - level(baseline.result.samples, name)) - 1);
    const y = changes.columns[index];
    const mx = x.reduce((a, b) => a + b, 0) / x.length; const my = y.reduce((a, b) => a + b, 0) / y.length;
    const beta = x.reduce((sum, v, i) => sum + (v - mx) * (y[i] - my), 0) / x.reduce((sum, v) => sum + (v - mx) ** 2, 0);
    const correlation = beta * Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) / y.reduce((s, v) => s + (v - my) ** 2, 0));
    console.log(`  ${name.padEnd(8)} model ${effect.toFixed(2).padStart(6)}%   regression ${(-5 * beta).toFixed(2).padStart(6)}% (beta ${beta.toFixed(2)}, correlation ${correlation.toFixed(2)})`);
}
await baseline.cleanup?.(); await child.cleanup?.();
