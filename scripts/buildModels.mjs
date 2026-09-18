/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Generates the reference models in models/ as .kjt files. Models are authored as code so their
// structure is reviewable in git and regenerated deterministically; the real Konjugate encoder
// writes the container.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateModule } from './konjugatePaths.mjs';

const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));

const copyright = 'Copyright © 2026 Zenin Easa Panthakkalakath';

class ModelBuilder {
    #nextId = 1;
    nodes = [];
    edges = [];

    id() { return this.#nextId++; }

    node(name, type, position, shape, color, states) {
        const node = {
            id: this.id(), name, type, position, sourceTerms: [],
            states: states.map(([symbol, label, initialValue, unit]) => ({ id: this.id(), name: label, symbol, initialValue, unit })),
            appearance: { type: 'primitive', shape, color }
        };
        this.nodes.push(node);
        return node;
    }

    state(node, symbol) { return node.states.find((state) => state.symbol === symbol); }

    // `bindings` maps an expression symbol to "source.<state>", "target.<state>" or a parameter symbol.
    edge({ name, source, target, bidirectional = false, output, mathJson, latex, parameters = [], bindings, color }) {
        const parameterRecords = parameters.map(({ symbol, name: parameterName, value, unit, live }) => ({
            id: this.id(), name: parameterName, symbol, value, unit,
            mode: live ? 'live' : 'constant',
            ...(live ? { control: live } : {})
        }));
        const bindingRecords = Object.entries(bindings).map(([symbol, reference]) => {
            const [role, stateSymbol] = reference.split('.');
            if (stateSymbol === undefined) {
                return { kind: 'parameter', parameterId: parameterRecords.find((parameter) => parameter.symbol === reference).id, symbol };
            }
            const node = role === 'source' ? source.node : target.node;
            return { kind: 'state', role, nodeId: node.id, stateId: this.state(node, stateSymbol).id, symbol };
        });
        const outputNode = output.role === 'source' ? source.node : target.node;
        this.edges.push({
            id: this.id(), name,
            source: { nodeId: source.node.id, stateId: this.state(source.node, source.state).id },
            target: { nodeId: target.node.id, stateId: this.state(target.node, target.state).id },
            directionality: bidirectional ? 'bidirectional' : 'directed',
            equation: latex,
            equationModel: {
                latex,
                output: { role: output.role, stateId: this.state(outputNode, output.state).id },
                bindings: bindingRecords,
                mathJson
            },
            parameters: parameterRecords,
            appearance: { color, offset: 0 }
        });
    }

    document({ globalTimeStep, outputInterval }) {
        const runConfigurationId = this.id();
        return {
            format: 'konjugate', version: 1, copyright, metadata: { units: 'SI' }, nodes: this.nodes, edges: this.edges,
            runConfigurations: [{ id: runConfigurationId, name: 'Default', globalTimeStep, outputInterval }],
            activeRunConfigurationId: runConfigurationId
        };
    }
}

// Interbank liquidity run. Three banks share reserves through interbank lending; depositors
// run on bank A, with withdrawals accelerating as its reserves fall below target (the panic
// feedback that makes a run self-reinforcing). A central bank holds a large reserve pool behind
// a live "injection" parameter that is 0 in the baseline: fork the run mid-crisis and raise it
// to see the counterfactual. Every flow is either a bidirectional edge or a matched pair, so
// total money (all reserves + wallet cash) is conserved by construction.
function interbankLiquidityRun() {
    const model = new ModelBuilder();
    const bankColor = '#2f6970';
    const bankA = model.node('Bank A', 'Commercial bank', [-3, 0, 0], 'box', bankColor, [['reserves', 'Reserves', 100, 'M'], ['deposits', 'Deposits', 850, 'M']]);
    const bankB = model.node('Bank B', 'Commercial bank', [0, 2, 0], 'box', bankColor, [['reserves', 'Reserves', 100, 'M'], ['deposits', 'Deposits', 850, 'M']]);
    const bankC = model.node('Bank C', 'Commercial bank', [0, -2, 0], 'box', bankColor, [['reserves', 'Reserves', 100, 'M'], ['deposits', 'Deposits', 850, 'M']]);
    const wallets = model.node('Depositor wallets', 'Cash holdings', [-6, 0, 0], 'sphere', '#c48a3f', [['cash', 'Cash', 0, 'M']]);
    const centralBank = model.node('Central bank', 'Central bank', [3, 0, 0], 'cylinder', '#9c83c4', [['reserves', 'Reserves', 1000, 'M']]);

    // Withdrawal outflow rate, shared by the reserve-side and deposit-side edges so the two
    // sides always move by exactly the same amount.
    const withdrawal = (bank) => ['Multiply', 'withdrawalRate', `${bank}Deposits`,
        ['Add', 1, ['Multiply', 'panicSensitivity', ['Max', 0, ['Add', 1, ['Negate', ['Divide', `${bank}Reserves`, 'reserveTarget']]]]]]];
    const withdrawalLatex = (bank) => `\\mathrm{withdrawalRate} \\cdot \\mathrm{${bank}Deposits} \\cdot \\left(1 + \\mathrm{panicSensitivity} \\cdot \\max\\left(0, 1 - \\frac{\\mathrm{${bank}Reserves}}{\\mathrm{reserveTarget}}\\right)\\right)`;
    const withdrawalParameters = () => [
        { symbol: 'withdrawalRate', name: 'Withdrawal rate', value: 0.005, unit: '1/day' },
        { symbol: 'panicSensitivity', name: 'Panic sensitivity', value: 4, unit: '' },
        { symbol: 'reserveTarget', name: 'Reserve target', value: 100, unit: 'M' }
    ];

    model.edge({
        name: 'Withdrawals (reserves)', source: { node: bankA, state: 'reserves' }, target: { node: wallets, state: 'cash' },
        bidirectional: true, output: { role: 'target', state: 'cash' },
        mathJson: withdrawal('source'), latex: withdrawalLatex('source'), parameters: withdrawalParameters(),
        bindings: { sourceDeposits: 'source.deposits', sourceReserves: 'source.reserves', withdrawalRate: 'withdrawalRate', panicSensitivity: 'panicSensitivity', reserveTarget: 'reserveTarget' },
        color: '#c48a3f'
    });
    model.edge({
        name: 'Withdrawals (deposits)', source: { node: wallets, state: 'cash' }, target: { node: bankA, state: 'deposits' },
        output: { role: 'target', state: 'deposits' },
        mathJson: ['Negate', withdrawal('target')], latex: `-${withdrawalLatex('target')}`, parameters: withdrawalParameters(),
        bindings: { targetDeposits: 'target.deposits', targetReserves: 'target.reserves', withdrawalRate: 'withdrawalRate', panicSensitivity: 'panicSensitivity', reserveTarget: 'reserveTarget' },
        color: '#c48a3f'
    });

    const flowLatex = '\\mathrm{flowRate} \\cdot \\left(\\mathrm{sourceReserves} - \\mathrm{targetReserves}\\right)';
    const flowMath = ['Multiply', 'flowRate', ['Add', 'sourceReserves', ['Negate', 'targetReserves']]];
    for (const [name, from, to] of [['Interbank A–B', bankA, bankB], ['Interbank B–C', bankB, bankC], ['Interbank A–C', bankA, bankC]]) {
        model.edge({
            name, source: { node: from, state: 'reserves' }, target: { node: to, state: 'reserves' },
            bidirectional: true, output: { role: 'target', state: 'reserves' },
            mathJson: flowMath, latex: flowLatex,
            parameters: [{ symbol: 'flowRate', name: 'Flow rate', value: 0.05, unit: '1/day' }],
            bindings: { sourceReserves: 'source.reserves', targetReserves: 'target.reserves', flowRate: 'flowRate' },
            color: '#c48a3f'
        });
    }

    model.edge({
        name: 'Central bank injection', source: { node: centralBank, state: 'reserves' }, target: { node: bankA, state: 'reserves' },
        bidirectional: true, output: { role: 'target', state: 'reserves' },
        mathJson: 'injection', latex: '\\mathrm{injection}',
        parameters: [{ symbol: 'injection', name: 'Injection', value: 0, unit: 'M/day', live: { minimum: 0, maximum: 100, step: 1 } }],
        bindings: { injection: 'injection' },
        color: '#9c83c4'
    });
    // Time is in days (the engine's "seconds" are just the model's time unit).
    return model.document({ globalTimeStep: 0.1, outputInterval: 0.5 });
}

const models = { interbankLiquidityRun };

export async function buildModels(outputDirectory = join(fintechRoot, 'models')) {
    await mkdir(outputDirectory, { recursive: true });
    const written = [];
    for (const [name, build] of Object.entries(models)) {
        const target = join(outputDirectory, `${name}.kjt`);
        await writeFile(target, await encodeProjectFile(JSON.stringify(build(), null, 2)));
        written.push(target);
        console.log(`Wrote ${target}`);
    }
    return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildModels();
