/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs Fintech Start headless, the way the window and the host do: the importer builds a model from the sample (or given) files and
// options, then scenarios are run as a baseline and a fork from it, with the same interventions and overrides the host applies. Used by
// the checks and the tests that need the real engine. Needs a built engine (see the ReadMe).
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateDir, konjugateModule } from './konjugatePaths.mjs';
import { summarizeRun } from '../packages/start/lib/explore.mjs';

export const host = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const adapter = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };
const bundleIds = ['commercialBank', 'depositorWallets', 'centralBank', 'assetMarket', 'depositRun', 'fireSale', 'interbankLendingScaled', 'interbankDefault', 'emergencyLending'];

// A copy of the package with its bundles, as the built add-on would have them.
export async function startPackage() {
    const directory = await mkdtemp(join(tmpdir(), 'start-harness-'));
    await cp(join(fintechRoot, 'packages', 'start'), directory, { recursive: true });
    for (const id of bundleIds) await cp(join(fintechRoot, 'packages', 'engine', 'components', `${id}.json`), join(directory, 'bundles', `${id}.json`));
    return { directory, manifest: JSON.parse(await readFile(join(directory, 'addon.json'), 'utf8')), remove: () => rm(directory, { recursive: true, force: true }) };
}

// A model built from the sample data (exposures 'given' or none) with the importer options given.
export async function buildModel(pack, { options = {}, exposures = 'given', institutionsText } = {}) {
    const files = [{ role: 'institutions', name: 'institutions.csv', text: institutionsText ?? await readFile(join(pack.directory, 'samples', 'institutions.csv'), 'utf8') }];
    if (exposures === 'given') files.push({ role: 'exposures', name: 'exposures.csv', text: await readFile(join(pack.directory, 'samples', 'exposures.csv'), 'utf8') });
    const imported = await host.runImporter({ addonDirectory: pack.directory, importer: pack.manifest.contributes.importers[0], files, options });
    return { imported, content: imported.ok ? JSON.stringify(imported.document) : null, options, baselines: new Map() };
}

async function baselineFor(model, runTime) {
    if (!model.baselines.has(runTime)) {
        const configuration = model.imported.document.runConfigurations[0];
        const config = { name: 'Baseline', targetTime: runTime, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
        const execution = await adapter.startEngineRun(model.content, config, engineOptions, { retainResult: true });
        model.baselines.set(runTime, { config, result: await execution.completion, cleanup: execution.cleanup });
    }
    return model.baselines.get(runTime);
}

// One scenario run: what the host does for a run request, returning the same shape of data the window receives.
export async function runScenario(pack, model, scenarioId, { entity = null, overrides = null, runTime = null } = {}) {
    const declared = pack.manifest.contributes.scenarios.find((scenario) => scenario.scenarioId === scenarioId);
    const scenario = { ...declared, ...(runTime === null ? {} : { runTime }) };
    const index = model.imported.parameterIndex;
    const interventions = host.applyOverrides(host.resolveInterventions(scenario, index, scenario.choose ? entity : null), index, overrides);
    const baseline = await baselineFor(model, scenario.runTime);
    const { forkTime, child } = await host.runScenarioBranches({ content: model.content, config: baseline.config, scenario, interventions, baseline, engineOptions });
    const samples = host.composeBranchSamples(baseline.result.samples, child.result.samples, forkTime);
    const document = model.imported.document;
    const symbols = ['equity', 'reserves'];
    const data = {
        scenarioId, entity, forkTime, runTime: scenario.runTime, interventions,
        branches: [{ id: 'baseline', series: host.extractSeries(baseline.result.samples, document, symbols) }, { id: 'scenario', series: host.extractSeries(samples, document, symbols) }]
    };
    await child.cleanup?.();
    return { data, summary: summarizeRun(data, model.imported.report.institutions), samples, document };
}

export async function release(model) {
    for (const baseline of model.baselines.values()) await baseline.cleanup?.();
    model.baselines.clear();
}
