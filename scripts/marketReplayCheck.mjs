/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Checks the "replay real moves" design on synthetic data with a planted link: learn from bars up to an as-of date,
// then play the driver's real moves for the next bars through the model and see how the follower's simulated path
// compares with what it actually did, and with the "no change" guess. Usage: node scripts/marketReplayCheck.mjs
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateDir, konjugateModule } from './konjugatePaths.mjs';
import { inferenceCsv, skeletonThresholdFor, toChanges } from '../packages/markets/lib/market.mjs';

const host = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const adapter = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };
let seed = 777;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
const bars = 700; const asOf = 600; const horizon = 20;
const gold = []; const miners = []; const noise = [];
for (let bar = 0; bar < bars; bar += 1) {
    gold.push(0.01 * normal());
    miners.push((bar ? 0.9 * gold[bar - 1] : 0) + 0.008 * normal());
    noise.push(0.01 * normal());
}
const file = (name, returns) => {
    let price = 100;
    const lines = ['Date,Close', ...returns.map((change, index) => { price *= Math.exp(change); return `${new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10)},${price.toFixed(6)}`; })];
    return { role: 'series', name: `${name}.csv`, text: `${lines.join('\n')}\n`, encoding: 'utf-8' };
};
const files = [file('Gold', gold), file('Miners', miners), file('Noise', noise)];
const addonDirectory = join(fintechRoot, 'packages', 'markets');
const importer = { entry: 'importers/marketSeries.mjs' };
const full = await host.runImporter({ addonDirectory, importer, files, options: { stage: 'read' } });
const dates = full.data.dates;
const to = dates[asOf];
const view = await host.runImporter({ addonDirectory, importer, files, options: { stage: 'read', to } });
const learned = toChanges({ names: full.data.names, dates: dates.slice(0, asOf + 1), columns: full.data.columns.map((column) => column.slice(0, asOf + 1)) });
const infer = async (csv, config) => (await adapter.inferWithEngine(csv, config, engineOptions)).report;
const report = await infer(inferenceCsv(learned, learned.dates.length - 250), { skeletonThreshold: skeletonThresholdFor(250) });
const built = await host.runImporter({ addonDirectory, importer, files, options: { stage: 'build', to, edges: report.edges.filter((edge) => edge.provenance !== 'correlationOnly'), selfTerms: report.selfTerms } });
console.log('learned on', view.report.summary.bars, 'bars to', to, '; built', JSON.stringify(built.report.summary));
const content = JSON.stringify(built.document);
const configuration = built.document.runConfigurations[0];
const config = { name: 'Baseline', targetTime: horizon, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
const run = async (cfg, prepare) => { const execution = await adapter.startEngineRun(content, cfg, engineOptions, { retainResult: true }); if (prepare) await prepare(execution); return { result: await execution.completion, cleanup: execution.cleanup }; };
const baseline = await run(config);
// The driver's real returns for the bars after the as-of date, each held for its bar.
const actual = (name) => { const column = full.data.columns[full.data.names.indexOf(name)]; return Array.from({ length: horizon }, (_, k) => Math.log(column[asOf + 1 + k] / column[asOf + k])); };
const samples = actual('Gold').flatMap((value, k) => [[k + 0.001, value], [k + 0.999, value]]);
const scenario = { scenarioId: 'replay', name: 'Replay', forkAt: 0, runTime: horizon, interventions: [{ parameter: 'trackGain', target: 'supplied', value: 10 }, { parameter: 'drive', target: 'supplied', samples: true }] };
const interventions = host.resolveInterventions(scenario, built.parameterIndex, null, { entities: ['Gold'], samples: { Gold: samples } });
const { child } = await host.runScenarioBranches({ content, config, scenario, interventions, baseline, engineOptions });
const level = (samplesList, node) => { const target = built.document.nodes.find((item) => item.name === node); return samplesList.at(-1).states.find((item) => item.stateId === target.states.find((state) => state.symbol === 'lvl').id).value; };
for (const name of ['Gold', 'Miners', 'Noise']) {
    const real = actual(name).reduce((sum, value) => sum + value, 0);
    const simulated = level(child.result.samples, name);
    console.log(`${name}: actual ${(100 * real).toFixed(2)}%, simulated with Gold replayed ${(100 * simulated).toFixed(2)}%, no-change guess 0%${name === 'Gold' ? ' (Gold is the driver: this shows how closely it is held to its real path)' : ''}`);
}
await baseline.cleanup?.(); await child.cleanup?.();
