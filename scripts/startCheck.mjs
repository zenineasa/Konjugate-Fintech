/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs every Start scenario headless on the sample data (or on the two files given) and reports what a reviewer would look
// at: the lowest reserves each bank reaches, how far central-bank support runs on, who fails and when, and the balance sheets.
// Usage: node scripts/startCheck.mjs [institutions.csv [exposures.csv]]
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateDir, konjugateModule } from './konjugatePaths.mjs';

const host = await import(pathToFileURL(konjugateModule('src/launcherHost.mjs')));
const adapter = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const engineOptions = { applicationPath: konjugateDir, resourcesPath: '', packaged: false };
const directory = await mkdtemp(join(tmpdir(), 'startcheck-'));
try {
    await cp(join(fintechRoot, 'packages', 'toolbox'), directory, { recursive: true });
    for (const id of ['commercialBank', 'depositorWallets', 'centralBank', 'assetMarket', 'depositRun', 'fireSale', 'interbankLendingScaled', 'interbankDefault', 'emergencyLending']) {
        await cp(join(fintechRoot, 'packages', 'engine', 'components', `${id}.json`), join(directory, 'bundles', `${id}.json`));
    }
    const manifest = JSON.parse(await readFile(join(directory, 'addon.json'), 'utf8'));
    const samples = join(directory, 'samples');
    const institutions = await readFile(process.argv[2] ?? join(samples, 'institutions.csv'), 'utf8');
    const exposures = process.argv[2] ? (process.argv[3] ? await readFile(process.argv[3], 'utf8') : undefined) : await readFile(join(samples, 'exposures.csv'), 'utf8');
    const importer = manifest.contributes.importers[0];
    const files = [{ role: 'institutions', name: 'institutions.csv', text: institutions }, ...(exposures === undefined ? [] : [{ role: 'exposures', name: 'exposures.csv', text: exposures }])];
    const imported = await host.runImporter({ addonDirectory: directory, importer, files });
    if (!imported.ok) { console.log('Import refused:', imported.report.errors.map((error) => `line ${error.line}: ${error.message}`).join(' | ')); process.exit(0); }
    const content = JSON.stringify(imported.document);
    const configuration = imported.document.runConfigurations[0];
    const config = { name: 'Baseline', targetTime: 60, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
    const run = async (cfg, prepare) => { const execution = await adapter.startEngineRun(content, cfg, engineOptions, { retainResult: true }); if (prepare) await prepare(execution); return { result: await execution.completion, cleanup: execution.cleanup }; };
    const baseline = await run(config);
    const banks = imported.document.nodes.filter((node) => node.states.some((state) => state.symbol === 'equity'));
    const series = (samples, node, symbol) => samples.map((sample) => sample.states.find((item) => item.stateId === node.states.find((state) => state.symbol === symbol).id).value);
    const largest = imported.report.institutions.reduce((best, row) => (row.assets > best.assets ? row : best)).name;
    const report = (label, samples) => {
        const failed = banks.filter((bank) => series(samples, bank, 'equity').some((value) => value < 0)).map((bank) => `${bank.name} (day ${samples[series(samples, bank, 'equity').findIndex((value) => value < 0)].time.toFixed(1)})`);
        const lowest = Math.min(...banks.flatMap((bank) => series(samples, bank, 'reserves')));
        const conserved = Math.max(...samples.flatMap((sample) => banks.map((bank) => {
            const v = (symbol) => sample.states.find((item) => item.stateId === bank.states.find((state) => state.symbol === symbol).id).value;
            return Math.abs(v('reserves') + v('loans') + v('claims') - v('deposits') - v('equity') - v('borrowing'));
        })));
        const alder = banks.find((bank) => bank.name === largest);
        console.log(`${label}: failing on equity: ${failed.length ? failed.join(', ') : 'none'}; lowest reserves any bank reaches ${lowest.toFixed(1)}; ${largest} ends with equity ${series(samples, alder, 'equity').at(-1).toFixed(0)} (start ${series(samples, alder, 'equity')[0].toFixed(0)}), reserves ${series(samples, alder, 'reserves').at(-1).toFixed(0)} and borrowing ${series(samples, alder, 'borrowing').at(-1).toFixed(0)}; balance-sheet error ${conserved.toExponential(1)}`);
    };
    report('Baseline', baseline.result.samples);
    for (const scenario of manifest.contributes.scenarios) {
        // RATE=0.03 tries a different depositor withdrawal rate in the scenarios that run on one institution, to tune severities.
        if (process.env.HAIRCUT) for (const change of scenario.interventions) if (change.parameter === 'baseHaircut') change.value = Number(process.env.HAIRCUT);
        if (process.env.RATE) for (const change of scenario.interventions) if (change.parameter === 'withdrawalRate' && change.target === 'chosen') change.value = Number(process.env.RATE);
        const interventions = host.resolveInterventions(scenario, imported.parameterIndex, scenario.choose ? largest : null);
        const { child } = await host.runScenarioBranches({ content, config, scenario, interventions, baseline, engineOptions });
        report(scenario.name, host.composeBranchSamples(baseline.result.samples, child.result.samples, scenario.forkAt));
        await child.cleanup?.();
    }
    await baseline.cleanup?.();
} finally {
    await rm(directory, { recursive: true, force: true });
}
