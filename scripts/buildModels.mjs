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
    sharedParameters = [];

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

    // A project-level parameter that edge parameters link to via `shared`, so one value or one
    // live control drives every linked parameter.
    sharedParameter({ symbol, name, value, unit, live }) {
        const shared = {
            id: this.id(), name, symbol, value, unit, mode: live ? 'live' : 'constant',
            ...(live ? { control: live } : {})
        };
        this.sharedParameters.push(shared);
        return shared;
    }

    state(node, symbol) { return node.states.find((state) => state.symbol === symbol); }

    // `bindings` maps an expression symbol to "source.<state>", "target.<state>" or a parameter symbol.
    edge({ name, source, target, bidirectional = false, output, mathJson, latex, parameters = [], bindings, color }) {
        const parameterRecords = parameters.map(({ symbol, name: parameterName, value, unit, live, shared }) => ({
            id: this.id(), name: parameterName, symbol, value: shared?.value ?? value, unit: shared?.unit ?? unit,
            mode: (shared ? shared.mode === 'live' : live) ? 'live' : 'constant',
            ...((shared ? shared.control : live) ? { control: shared?.control ?? live } : {}),
            ...(shared ? { sharedParameterId: shared.id } : {})
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
            format: 'konjugate', version: 1, copyright, metadata: { units: 'SI' },
            ...(this.sharedParameters.length ? { sharedParameters: this.sharedParameters } : {}),
            nodes: this.nodes, edges: this.edges,
            runConfigurations: [{ id: runConfigurationId, name: 'Default', globalTimeStep, outputInterval }],
            activeRunConfigurationId: runConfigurationId
        };
    }
}

// Interbank liquidity and fire-sale run. Three banks hold reserves, loans, deposits, equity and
// a net interbank borrowing position, so every balance sheet satisfies
// reserves + loans = deposits + equity + interbank at all times. Depositors run on bank A,
// with withdrawals accelerating as its reserves fall below target (the panic feedback that makes
// a run self-reinforcing). Two contagion channels spread the stress: interbank lending moves
// reserves (and the matching borrowing position) between banks, and any bank short of reserves
// fire-sells loans into a shared market whose price falls as holdings pile up -- so one bank's
// distress lowers the sale proceeds, and raises the losses, of every other. A central bank
// behind a live "injection" parameter (0 in the baseline) supplies emergency lending: fork the
// run mid-crisis and raise it to see the counterfactual. Every flow is a bidirectional edge or a
// matched pair, so balance-sheet identities and total money hold by construction.
function interbankLiquidityRun({ nodesOnly = false } = {}) {
    const model = new ModelBuilder();
    const bankColor = '#2f6970';
    const bankStates = () => [['reserves', 'Reserves', 100, 'M'], ['loans', 'Loans', 800, 'M'], ['deposits', 'Deposits', 850, 'M'], ['equity', 'Equity', 50, 'M'], ['interbank', 'Interbank borrowing', 0, 'M']];
    const bankA = model.node('Bank A', 'Commercial bank', [-3, 0, 0], 'box', bankColor, bankStates());
    const bankB = model.node('Bank B', 'Commercial bank', [0, 2, 0], 'box', bankColor, bankStates());
    const bankC = model.node('Bank C', 'Commercial bank', [0, -2, 0], 'box', bankColor, bankStates());
    const banks = [bankA, bankB, bankC];
    const wallets = model.node('Depositor wallets', 'Cash holdings', [-6, 0, 0], 'sphere', '#c48a3f', [['cash', 'Cash', 0, 'M']]);
    const centralBank = model.node('Central bank', 'Central bank', [3, 0, 0], 'cylinder', '#9c83c4', [['reserves', 'Reserves', 1000, 'M']]);
    const market = model.node('Asset market', 'Fire-sale buyers', [0, 0, 3], 'sphere', '#d98b54', [['cash', 'Buyer cash', 1000, 'M'], ['holdings', 'Loan holdings', 0, 'M']]);
    const flowColor = '#c48a3f';
    // Just the six nodes, no edges: the starting point for wiring the same model up with the
    // plugin's component bundles instead (see tests/interaction/run.mjs).
    if (nodesOnly) return finish();

    // Withdrawal outflow rate, shared by the reserve-side and deposit-side edges so the two
    // sides always move by exactly the same amount.
    const withdrawal = (bank) => ['Multiply', 'withdrawalRate', `${bank}Deposits`,
        ['Add', 1, ['Multiply', 'panicSensitivity', ['Max', 0, ['Add', 1, ['Negate', ['Divide', `${bank}Reserves`, 'reserveTarget']]]]]]];
    const withdrawalLatex = (bank) => `\\mathrm{withdrawalRate} \\cdot \\mathrm{${bank}Deposits} \\cdot \\left(1 + \\mathrm{panicSensitivity} \\cdot \\max\\left(0, 1 - \\frac{\\mathrm{${bank}Reserves}}{\\mathrm{reserveTarget}}\\right)\\right)`;
    // Behavioral and policy constants used by many edges are shared parameters: one definition each,
    // so calibrating (or forking on) one of them changes every edge that uses it.
    const reserveTarget = model.sharedParameter({ symbol: 'reserveTarget', name: 'Reserve target', value: 100, unit: 'M' });
    const withdrawalRate = model.sharedParameter({ symbol: 'withdrawalRate', name: 'Withdrawal rate', value: 0.005, unit: '1/day' });
    const panicSensitivity = model.sharedParameter({ symbol: 'panicSensitivity', name: 'Panic sensitivity', value: 4, unit: '' });
    const fireSaleRate = model.sharedParameter({ symbol: 'fireSaleRate', name: 'Fire-sale rate', value: 0.02, unit: '1/day' });
    const baseHaircut = model.sharedParameter({ symbol: 'baseHaircut', name: 'Base haircut', value: 0.1, unit: '' });
    const priceImpact = model.sharedParameter({ symbol: 'priceImpact', name: 'Price impact', value: 0.0005, unit: '1/M' });
    const interbankFlowRate = model.sharedParameter({ symbol: 'flowRate', name: 'Interbank flow rate', value: 0.05, unit: '1/day' });
    const withdrawalParameters = () => [
        { symbol: 'withdrawalRate', name: 'Withdrawal rate', shared: withdrawalRate },
        { symbol: 'panicSensitivity', name: 'Panic sensitivity', shared: panicSensitivity },
        { symbol: 'reserveTarget', name: 'Reserve target', shared: reserveTarget }
    ];
    model.edge({
        name: 'Withdrawals (reserves)', source: { node: bankA, state: 'reserves' }, target: { node: wallets, state: 'cash' },
        bidirectional: true, output: { role: 'target', state: 'cash' },
        mathJson: withdrawal('source'), latex: withdrawalLatex('source'), parameters: withdrawalParameters(),
        bindings: { sourceDeposits: 'source.deposits', sourceReserves: 'source.reserves', withdrawalRate: 'withdrawalRate', panicSensitivity: 'panicSensitivity', reserveTarget: 'reserveTarget' },
        color: flowColor
    });
    model.edge({
        name: 'Withdrawals (deposits)', source: { node: wallets, state: 'cash' }, target: { node: bankA, state: 'deposits' },
        output: { role: 'target', state: 'deposits' },
        mathJson: ['Negate', withdrawal('target')], latex: `-${withdrawalLatex('target')}`, parameters: withdrawalParameters(),
        bindings: { targetDeposits: 'target.deposits', targetReserves: 'target.reserves', withdrawalRate: 'withdrawalRate', panicSensitivity: 'panicSensitivity', reserveTarget: 'reserveTarget' },
        color: flowColor
    });

    // Interbank lending: reserves flow toward the poorer bank, and the borrower's interbank
    // liability grows by the same amount, keeping both balance sheets balanced.
    const flowLatex = (state) => `\\mathrm{flowRate} \\cdot \\left(\\mathrm{sourceReserves} - \\mathrm{targetReserves}\\right)`;
    const flowMath = ['Multiply', 'flowRate', ['Add', 'sourceReserves', ['Negate', 'targetReserves']]];
    const flowBindings = { sourceReserves: 'source.reserves', targetReserves: 'target.reserves', flowRate: 'flowRate' };
    const flowParameters = () => [{ symbol: 'flowRate', name: 'Flow rate', shared: interbankFlowRate }];
    for (const [name, from, to] of [['Interbank A–B', bankA, bankB], ['Interbank B–C', bankB, bankC], ['Interbank A–C', bankA, bankC]]) {
        model.edge({
            name: `${name} (reserves)`, source: { node: from, state: 'reserves' }, target: { node: to, state: 'reserves' },
            bidirectional: true, output: { role: 'target', state: 'reserves' },
            mathJson: flowMath, latex: flowLatex(), parameters: flowParameters(), bindings: flowBindings, color: flowColor
        });
        model.edge({
            name: `${name} (borrowing)`, source: { node: from, state: 'interbank' }, target: { node: to, state: 'interbank' },
            bidirectional: true, output: { role: 'target', state: 'interbank' },
            mathJson: flowMath, latex: flowLatex(), parameters: flowParameters(), bindings: flowBindings, color: flowColor
        });
    }

    // Fire sales: a bank short of reserves sells loans at a price that falls as the market's
    // holdings grow. Sold loans leave the bank and land in the market; the proceeds come out of
    // the buyers' cash into the bank's reserves; the shortfall against book value hits equity.
    const price = ['Max', 0, ['Add', 1, ['Negate', 'baseHaircut'], ['Negate', ['Multiply', 'priceImpact', 'sourceHoldings']]]];
    const priceLatex = '\\max\\left(0, 1 - \\mathrm{baseHaircut} - \\mathrm{priceImpact} \\cdot \\mathrm{sourceHoldings}\\right)';
    const saleVolume = (loans, reserves) => ['Multiply', 'fireSaleRate', loans,
        ['Max', 0, ['Add', 1, ['Negate', ['Divide', reserves, 'reserveTarget']]]]];
    const saleVolumeLatex = (loans, reserves) => `\\mathrm{fireSaleRate} \\cdot \\mathrm{${loans}} \\cdot \\max\\left(0, 1 - \\frac{\\mathrm{${reserves}}}{\\mathrm{reserveTarget}}\\right)`;
    const saleParameters = () => [
        { symbol: 'fireSaleRate', name: 'Fire-sale rate', shared: fireSaleRate },
        { symbol: 'reserveTarget', name: 'Reserve target', shared: reserveTarget },
        { symbol: 'baseHaircut', name: 'Base haircut', shared: baseHaircut },
        { symbol: 'priceImpact', name: 'Price impact', shared: priceImpact }
    ];
    const saleBindings = { fireSaleRate: 'fireSaleRate', reserveTarget: 'reserveTarget', baseHaircut: 'baseHaircut', priceImpact: 'priceImpact' };
    for (const bank of banks) {
        const label = bank.name;
        // Loans transferred: bank (source) -> market (target).
        model.edge({
            name: `${label} fire sale (loans)`, source: { node: bank, state: 'loans' }, target: { node: market, state: 'holdings' },
            bidirectional: true, output: { role: 'target', state: 'holdings' },
            mathJson: saleVolume('sourceLoans', 'sourceReserves'), latex: saleVolumeLatex('sourceLoans', 'sourceReserves'),
            parameters: saleParameters(),
            bindings: { ...saleBindings, sourceLoans: 'source.loans', sourceReserves: 'source.reserves' }, color: '#d98b54'
        });
        // Proceeds: market cash (source) -> bank reserves (target), volume x price.
        model.edge({
            name: `${label} fire sale (proceeds)`, source: { node: market, state: 'cash' }, target: { node: bank, state: 'reserves' },
            bidirectional: true, output: { role: 'target', state: 'reserves' },
            mathJson: ['Multiply', saleVolume('targetLoans', 'targetReserves'), price],
            latex: `${saleVolumeLatex('targetLoans', 'targetReserves')} \\cdot ${priceLatex}`,
            parameters: saleParameters(),
            bindings: { ...saleBindings, targetLoans: 'target.loans', targetReserves: 'target.reserves', sourceHoldings: 'source.holdings' }, color: '#d98b54'
        });
        // Loss against book value: volume x (1 - price) comes out of equity.
        model.edge({
            name: `${label} fire sale (loss)`, source: { node: market, state: 'holdings' }, target: { node: bank, state: 'equity' },
            output: { role: 'target', state: 'equity' },
            mathJson: ['Negate', ['Multiply', saleVolume('targetLoans', 'targetReserves'), ['Add', 1, ['Negate', price]]]],
            latex: `-${saleVolumeLatex('targetLoans', 'targetReserves')} \\cdot \\left(1 - ${priceLatex}\\right)`,
            parameters: saleParameters(),
            bindings: { ...saleBindings, targetLoans: 'target.loans', targetReserves: 'target.reserves', sourceHoldings: 'source.holdings' }, color: '#d98b54'
        });
    }

    // Central bank emergency lending to bank A: reserves in, matching borrowing recorded.
    // Both legs of the lending facility link to one shared parameter, so a single knob (or a single
    // fork intervention) drives the reserves and the matching borrowing together.
    const emergencyLending = model.sharedParameter({ symbol: 'injection', name: 'Emergency lending', value: 0, unit: 'M/day', live: { minimum: 0, maximum: 100, step: 1 } });
    const injectionParameters = () => [{ symbol: 'injection', name: 'Emergency lending', shared: emergencyLending }];
    model.edge({
        name: 'Central bank injection (reserves)', source: { node: centralBank, state: 'reserves' }, target: { node: bankA, state: 'reserves' },
        bidirectional: true, output: { role: 'target', state: 'reserves' },
        mathJson: 'injection', latex: '\\mathrm{injection}', parameters: injectionParameters(), bindings: { injection: 'injection' }, color: '#9c83c4'
    });
    model.edge({
        name: 'Central bank injection (borrowing)', source: { node: centralBank, state: 'reserves' }, target: { node: bankA, state: 'interbank' },
        output: { role: 'target', state: 'interbank' },
        mathJson: 'injection', latex: '\\mathrm{injection}', parameters: injectionParameters(), bindings: { injection: 'injection' }, color: '#9c83c4'
    });

    return finish();

    function finish() {
        const ids = Object.fromEntries(model.nodes.flatMap((node) => node.states.map((state) => [`${node.name}.${state.symbol}`, state.id])));
        // Time is in days (the engine's "seconds" are just the model's time unit).
        return { document: model.document({ globalTimeStep: 0.1, outputInterval: 0.5 }), states: ids, nodes: Object.fromEntries(model.nodes.map((node) => [node.name, node.id])) };
    }
}

const models = { interbankLiquidityRun: () => interbankLiquidityRun() };

// The same six nodes with no edges, written to `path`, for tests that wire the model up themselves.
export async function writeNodesOnlyInterbankRun(path) {
    const { document, states, nodes } = interbankLiquidityRun({ nodesOnly: true });
    await writeFile(path, await encodeProjectFile(JSON.stringify(document, null, 2)));
    return { path, states, nodes };
}

export async function buildModels(outputDirectory = join(fintechRoot, 'models')) {
    await mkdir(outputDirectory, { recursive: true });
    const written = [];
    for (const [name, build] of Object.entries(models)) {
        const target = join(outputDirectory, `${name}.kjt`);
        const { document, states } = build();
        await writeFile(target, await encodeProjectFile(JSON.stringify(document, null, 2)));
        written.push({ name, path: target, states });
        console.log(`Wrote ${target}`);
    }
    return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildModels();
