/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds a Markets model from synthetic returns with a planted link, runs it forward with and without a shock, and
// compares the response with what the planted link implies. This is the check the simulate-ahead design promised:
// core inference recovers discrete lag coefficients while the model treats each edge as a rate, so a forward run
// should reproduce the fitted response only approximately. Usage: node scripts/marketModelCheck.mjs
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateDir, konjugateModule } from './konjugatePaths.mjs';
import { analyzeWindows, toChanges, alignSeries, skeletonThresholdFor, inferenceCsv } from '../packages/toolbox/lib/market.mjs';

const host = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const adapter = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };

let seed = 424242;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
const bars = 600;
const gold = []; const miners = []; const noise = [];
for (let bar = 0; bar < bars; bar += 1) {
    gold.push(0.01 * normal());
    miners.push((bar ? 0.5 * gold[bar - 1] : 0) + 0.008 * normal());
    noise.push(0.01 * normal());
}
const priceFile = (name, returns) => {
    let price = 100;
    const lines = ['Date,Close'];
    returns.forEach((change, index) => { price *= Math.exp(change); lines.push(`${new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)},${price.toFixed(6)}`); });
    return { role: 'series', name: `${name}.csv`, text: `${lines.join('\n')}\n`, encoding: 'utf-8' };
};
const files = [priceFile('Gold', gold), priceFile('Miners', miners), priceFile('Noise', noise)];
const importer = { entry: 'importers/marketSeries.mjs' };
const addonDirectory = join(fintechRoot, 'packages', 'toolbox');

const read = await host.runImporter({ addonDirectory, importer, files, options: { stage: 'read' } });
console.log('read:', JSON.stringify(read.report.summary), read.report.warnings.length, 'warnings');
const changes = toChanges({ names: read.data.names, dates: read.data.dates, columns: read.data.columns });
const infer = async (csv, config) => { const result = await adapter.inferWithEngine(csv, config, engineOptions); return result.report; };
const analysis = await analyzeWindows(changes, { length: 150, count: 3 }, infer);
console.log('links:', analysis.links.map((link) => `${link.source}->${link.target} ${link.label}`).join('; '));
const latest = await infer(inferenceCsv(changes, changes.dates.length - 300), { skeletonThreshold: skeletonThresholdFor(300) });
const built = await host.runImporter({ addonDirectory, importer, files, options: { stage: 'build', edges: latest.edges.filter((edge) => edge.provenance !== 'correlationOnly'), selfTerms: latest.selfTerms } });
console.log('build:', built.ok, JSON.stringify(built.report.summary), built.report.warnings.map((warning) => warning.message));
const content = JSON.stringify(built.document);
const validation = await adapter.validateWithEngine(content, engineOptions);
console.log('validation:', validation.available ? JSON.stringify({ valid: validation.report.valid, issues: validation.report.issues.slice(0, 5).map((issue) => issue.message) }) : 'engine unavailable');

const configuration = built.document.runConfigurations[0];
const config = { name: 'Baseline', targetTime: 30, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
const runToCompletion = async (cfg, prepare) => {
    const execution = await adapter.startEngineRun(content, cfg, engineOptions, { retainResult: true });
    if (prepare) await prepare(execution);
    return { result: await execution.completion, cleanup: execution.cleanup };
};
const baseline = await runToCompletion(config);
const entry = built.parameterIndex.find((item) => item.entity === 'Gold');
const interventions = [{ sharedParameterId: entry.sharedParameterId, value: 0.1, at: 0, duration: 1, baseValue: 0 }];
const { forkTime, child } = await host.runScenarioBranches({ content, config, scenario: { forkAt: 1, runTime: 30 }, interventions, baseline, engineOptions });
const level = (samples, node) => {
    const target = built.document.nodes.find((item) => item.name === node);
    const state = target.states.find((item) => item.symbol === 'lvl');
    const sample = samples.at(-1);
    return sample.states.find((item) => item.stateId === state.id).value;
};
const goldEffect = level(child.result.samples, 'Gold') - level(baseline.result.samples, 'Gold');
const minersEffect = level(child.result.samples, 'Miners') - level(baseline.result.samples, 'Miners');
const noiseEffect = level(child.result.samples, 'Noise') - level(baseline.result.samples, 'Noise');
const coefficient = latest.edges.find((edge) => edge.sourceColumn === 'Gold' && edge.targetColumn === 'Miners')?.terms[0].coefficient;
console.log(`fork at ${forkTime}: a 0.10 shock to Gold moves Gold by ${goldEffect.toFixed(4)}, Miners by ${minersEffect.toFixed(4)} (the planted link implies ${(0.5 * 0.1).toFixed(4)}), Noise by ${noiseEffect.toFixed(4)}; fitted rate ${coefficient?.toFixed(3)}`);
await baseline.cleanup?.(); await child.cleanup?.();
