/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Fetches real series from Yahoo Finance the way the Markets window does, and runs the same link analysis on them
// with Konjugate's engine. A way to see what the analysis says about real markets. Needs a network connection.
// Usage: node scripts/marketLive.mjs [years] [symbols separated by commas]
import { pathToFileURL } from 'node:url';
import { konjugateDir, konjugateModule } from './konjugatePaths.mjs';
import { alignSeries, analyzeWindows, parseSeriesFile, toChanges } from '../packages/toolbox/lib/market.mjs';

const host = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const adapter = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const years = Number(process.argv[2] ?? 5);
const symbols = (process.argv[3] ?? 'BZ=F,JETS,GC=F,GDX,^TNX,KBE,^GSPC').split(',');
const series = [];
for (const symbol of symbols) {
    const bytes = await host.fetchAllowed({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${years}y&interval=1d`, hosts: ['query1.finance.yahoo.com'] });
    series.push(parseSeriesFile(new TextDecoder().decode(bytes), symbol));
}
const aligned = alignSeries(series);
const changes = toChanges(aligned);
console.log(`${changes.names.length} series, ${changes.dates.length} bars, ${aligned.dates[0]} to ${aligned.dates.at(-1)}; lost: ${aligned.lost.map((item) => `${item.name} ${item.lost}`).join(', ')}`);
const options = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };
const infer = async (csv, config) => (await adapter.inferWithEngine(csv, config, options)).report;
for (const length of [60, 120, 250]) {
    if (length * 2 > changes.dates.length) continue;
    const result = await analyzeWindows(changes, { length, count: 8 }, infer);
    console.log(`\nStretches of ${length} bars (${result.windows.length} of them):`);
    for (const link of result.links.slice(0, 8)) {
        console.log(`  ${link.source} -> ${link.target}: ${link.appearances}/${link.windows}, sign ${link.sign > 0 ? '+' : '-'} ${(link.signAgreement * 100).toFixed(0)}%, ${link.label}${link.latest ? '' : ', not in newest'}`);
    }
    if (!result.links.length) console.log('  no lead-lag links in any stretch');
}

// A what-if on the real data: keep the steady links from the newest 250-bar stretch, build the model, and shock one series.
if (process.argv[4]) {
    const { preferTogetherDirection, inferenceCsv, skeletonThresholdFor } = await import('../packages/toolbox/lib/market.mjs');
    const { join } = await import('node:path');
    const { fintechRoot } = await import('./konjugatePaths.mjs');
    const length = 250;
    const result = await analyzeWindows(changes, { length, count: 5 }, infer);
    const spread = new Map(changes.names.map((name, index) => { const column = changes.columns[index]; const mean = column.reduce((a, b) => a + b, 0) / column.length; return [name.replace(/[^A-Za-z0-9_.-]+/g, '_'), Math.sqrt(column.reduce((a, b) => a + (b - mean) ** 2, 0) / column.length)]; }));
    const together = preferTogetherDirection(result.together, (name) => spread.get(name));
    const keep = new Set([...result.links, ...together.filter((link) => link.preferred)].filter((link) => link.latest && (link.label === 'stable' || link.label === 'sometimes')).map((link) => `${link.kind}|${link.source}|${link.target}`));
    const edges = result.reports[0].edges.filter((edge) => keep.has(`${edge.provenance === 'correlationOnly' ? 'together' : 'lagged'}|${edge.sourceColumn}|${edge.targetColumn}`));
    console.log(`\nKept ${edges.length} links: ${edges.map((edge) => `${edge.sourceColumn}>${edge.targetColumn}`).join(', ')}`);
    const files = symbols.map((symbol, index) => ({ role: 'series', name: `${symbol}.csv`, text: `Date,Close\n${aligned.dates.map((date, row) => `${date},${aligned.columns[index][row]}`).join('\n')}\n`, encoding: 'utf-8' }));
    const importer = { entry: 'importers/marketSeries.mjs' };
    const addonDirectory = join(fintechRoot, 'packages', 'toolbox');
    const built = await host.runImporter({ addonDirectory, importer, files, options: { stage: 'build', edges, selfTerms: result.reports[0].selfTerms } });
    const content = JSON.stringify(built.document);
    const configuration = built.document.runConfigurations[0];
    const config = { name: 'Baseline', targetTime: 21, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
    const start = await adapter.startEngineRun(content, config, options, { retainResult: true });
    const baseline = { result: await start.completion, cleanup: start.cleanup };
    const shocked = process.argv[4];
    const entry = built.parameterIndex.find((item) => item.entity === shocked);
    const { child } = await host.runScenarioBranches({ content, config, scenario: { forkAt: 1, runTime: 21 }, interventions: [{ sharedParameterId: entry.sharedParameterId, value: -0.05, at: 0, duration: 1, baseValue: 0 }], baseline, engineOptions: options });
    const level = (samples, node) => { const target = built.document.nodes.find((item) => item.name === node); return samples.at(-1).states.find((item) => item.stateId === target.states.find((state) => state.symbol === 'lvl').id).value; };
    console.log(`A 5% fall in ${shocked}, after 21 bars:`);
    for (const name of changes.names) console.log(`  ${name}: ${(100 * (Math.exp(level(child.result.samples, name) - level(baseline.result.samples, name)) - 1)).toFixed(2)}%`);
    await baseline.cleanup?.(); await child.cleanup?.();
}
