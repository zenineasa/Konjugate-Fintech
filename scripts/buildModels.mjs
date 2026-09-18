/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Generates the reference models in models/ as .kjt files. Models are authored as code so their
// structure is reviewable in git and regenerated deterministically; the real Konjugate encoder
// writes the container.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fintechRoot, konjugateModule } from './konjugatePaths.mjs';

const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));
const { reconcileEquationBindings, validateEquationLatex } = await import(pathToFileURL(konjugateModule('src/equationModel.mjs')));

// Every component template and bundle the plugin contributes, by id.
const pluginDirectory = join(fintechRoot, 'packages', 'engine');
const pluginManifest = JSON.parse(await readFile(join(pluginDirectory, 'plugin.json'), 'utf8'));
const bundleTemplates = Object.fromEntries(await Promise.all(pluginManifest.contributes.map(async (contribution) =>
    [contribution.componentId, JSON.parse(await readFile(join(pluginDirectory, contribution.entry), 'utf8'))])));

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

    // Instantiates a bundle template between the given endpoint nodes ({ endpointId: node }),
    // mirroring what the app does when a user applies it: shared parameters are created (or, for a
    // "project"-scoped one, reused by symbol), each edge's equation is parsed with Konjugate's own
    // equation code, and every edge parameter links to its shared parameter.
    applyBundle(template, endpoints) {
        const sharedByKey = new Map();
        for (const declared of template.sharedParameters ?? []) {
            const existing = declared.scope === 'project' ? this.sharedParameters.find((shared) => shared.symbol === declared.symbol) : null;
            if (existing) {
                sharedByKey.set(declared.key, existing);
                continue;
            }
            let symbol = declared.symbol;
            for (let suffix = 2; this.sharedParameters.some((shared) => shared.symbol === symbol); suffix += 1) symbol = `${declared.symbol}${suffix}`;
            sharedByKey.set(declared.key, this.sharedParameter({
                symbol, name: declared.name, value: declared.value, unit: declared.unit ?? '',
                live: declared.mode === 'live' ? declared.control : undefined
            }));
        }
        for (const edge of template.edges) {
            const fromNode = endpoints[edge.from];
            const toNode = endpoints[edge.to];
            const parameters = (edge.parameters ?? []).map((parameter) => {
                const shared = parameter.shared === undefined ? null : sharedByKey.get(parameter.shared);
                const source = shared ?? parameter;
                return {
                    id: this.id(), name: parameter.name, symbol: parameter.symbol,
                    value: source.value ?? 0, unit: source.unit ?? '', mode: source.mode ?? 'constant',
                    ...(source.control ? { control: source.control } : {}),
                    ...(shared ? { sharedParameterId: shared.id } : {})
                };
            });
            const bindings = reconcileEquationBindings([], fromNode, toNode, parameters);
            const validation = validateEquationLatex(edge.latex, bindings);
            if (!validation.valid) throw new Error(`Bundle "${template.id}" edge "${edge.name}" has an invalid equation: ${validation.errors.join(' ')}`);
            const portState = (node, role, ports) => node.states.find((state) => state.symbol === (edge.output.role === role ? edge.output.state : [ports].flat()[0]));
            const outputNode = edge.output.role === 'source' ? fromNode : toNode;
            this.edges.push({
                id: this.id(), name: edge.name,
                source: { nodeId: fromNode.id, stateId: portState(fromNode, 'source', edge.ports.source).id },
                target: { nodeId: toNode.id, stateId: portState(toNode, 'target', edge.ports.target).id },
                directionality: edge.bidirectional ? 'bidirectional' : 'directed',
                equation: edge.latex,
                equationModel: {
                    latex: edge.latex,
                    output: { role: edge.output.role, stateId: outputNode.states.find((state) => state.symbol === edge.output.state).id },
                    bindings, mathJson: validation.mathJson
                },
                parameters,
                appearance: { color: edge.color ?? template.color ?? '#9c83c4', offset: 0 }
            });
        }
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

// Interbank liquidity, fire-sale and default cascade. Three banks share reserves through
// interbank lending, depositors run on bank A, banks short of reserves fire-sell loans into a
// shared market, and a bank whose equity turns negative defaults on its interbank debt, passing
// the shortfall to its creditors. Every edge comes from one of the plugin's component bundles
// (packages/engine/components/*.json), instantiated here exactly as the app instantiates them, so
// the model and the bundles cannot drift apart: the interaction test wires the same model up in the
// real app from the bundles and checks the two agree state for state. Balance sheets satisfy
// reserves + loans + claims = deposits + equity + borrowing and total money is conserved by
// construction. A central bank behind a live "Emergency lending" parameter (0 in the baseline)
// and a live "Base haircut" let you fork the run mid-crisis with a policy response or a fresh shock.
function interbankLiquidityRun({ nodesOnly = false } = {}) {
    const model = new ModelBuilder();
    const bankTemplate = bundleTemplates.commercialBank;
    const bankStates = () => bankTemplate.states.map((state) => [state.symbol, state.label, state.initialValue, state.unit]);
    const bankA = model.node('Bank A', 'Commercial bank', [-3, 0, 0], 'box', bankTemplate.color, bankStates());
    const bankB = model.node('Bank B', 'Commercial bank', [0, 2, 0], 'box', bankTemplate.color, bankStates());
    const bankC = model.node('Bank C', 'Commercial bank', [0, -2, 0], 'box', bankTemplate.color, bankStates());
    const banks = [bankA, bankB, bankC];
    const node = (id, name, position) => {
        const template = bundleTemplates[id];
        return model.node(name, template.name, position, template.shape, template.color, template.states.map((state) => [state.symbol, state.label, state.initialValue, state.unit]));
    };
    const wallets = node('depositorWallets', 'Depositor wallets', [-6, 0, 0]);
    const centralBank = node('centralBank', 'Central bank', [3, 0, 0]);
    const market = node('assetMarket', 'Asset market', [0, 0, 3]);
    // Just the six nodes, no edges: the starting point for wiring the same model up with the
    // plugin's component bundles in the app instead (see tests/interaction/run.mjs).
    if (nodesOnly) return finish();

    model.applyBundle(bundleTemplates.depositRun, { bank: bankA, wallets });
    for (const bank of banks) model.applyBundle(bundleTemplates.fireSale, { bank, market });
    // Banks lend in both directions (whichever holds more reserves lends), and each bank's
    // interbank debt is assumed split evenly between the other two banks.
    for (const lender of banks) {
        for (const borrower of banks.filter((bank) => bank !== lender)) {
            model.applyBundle(bundleTemplates.interbankLending, { lender, borrower });
            model.applyBundle(bundleTemplates.interbankDefault, { borrower, creditor: lender });
        }
    }
    model.applyBundle(bundleTemplates.emergencyLending, { centralBank, bank: bankA });
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
