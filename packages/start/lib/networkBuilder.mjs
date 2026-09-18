/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds a Konjugate project document node by node and bundle by bundle, the way the app's component
// library would, but from data. It is deliberately dependency-free: the host supplies the two
// equation helpers it needs (`reconcileEquationBindings` and `validateEquationLatex`), so this file
// runs unchanged inside the importer worker and in tests.

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// "Alder Bank" -> "AlderBank": a valid lower-camel-case symbol fragment (letters and digits only).
export function symbolFragment(text) {
    const cleaned = String(text).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(capitalize).join('');
    return /^[A-Za-z]/.test(cleaned) ? cleaned : `X${cleaned}`;
}

export class NetworkBuilder {
    #nextId = 1;
    #helpers;
    nodes = [];
    edges = [];
    sharedParameters = [];

    constructor(helpers) {
        this.#helpers = helpers;
    }

    id() { return this.#nextId++; }

    node({ name, type, position, shape, color, states }) {
        const node = {
            id: this.id(), name, type, position, sourceTerms: [],
            states: states.map(({ symbol, label, initialValue, unit }) => ({ id: this.id(), name: label, symbol, initialValue, unit })),
            appearance: { type: 'primitive', shape, color }
        };
        this.nodes.push(node);
        return node;
    }

    // A project-level parameter that edge parameters link to. `live` is a slider control ({minimum,
    // maximum, step}) and makes it adjustable during a run and available to fork interventions.
    sharedParameter({ symbol, name, value, unit = '', live }) {
        let unique = symbol;
        for (let suffix = 2; this.sharedParameters.some((shared) => shared.symbol === unique); suffix += 1) unique = `${symbol}${suffix}`;
        const shared = { id: this.id(), name, symbol: unique, value, unit, mode: live ? 'live' : 'constant', ...(live ? { control: live } : {}) };
        this.sharedParameters.push(shared);
        return shared;
    }

    // Patches a shared parameter and re-mirrors every linked edge parameter, which carries a copy of
    // the shared value, unit, mode and slider range so the editor shows what the engine will use.
    patchSharedParameter(shared, patch) {
        Object.assign(shared, patch);
        if (shared.mode !== 'live') delete shared.control;
        for (const edge of this.edges) for (const parameter of edge.parameters) {
            if (parameter.sharedParameterId !== shared.id) continue;
            parameter.value = shared.value;
            parameter.unit = shared.unit;
            parameter.mode = shared.mode;
            if (shared.control) parameter.control = shared.control;
            else delete parameter.control;
        }
    }

    // Instantiates a bundle template between the given endpoint nodes ({ endpointId: node }).
    // `bind` maps a template shared-parameter key to an existing shared parameter to use instead of
    // creating (or reusing by symbol) one; `label` is appended to every created edge's name. Returns
    // the shared parameters the bundle used, by key.
    applyBundle(template, endpoints, { bind = {}, label = '' } = {}) {
        const sharedByKey = new Map();
        for (const declared of template.sharedParameters ?? []) {
            if (bind[declared.key]) {
                sharedByKey.set(declared.key, bind[declared.key]);
                continue;
            }
            const existing = declared.scope === 'project' ? this.sharedParameters.find((shared) => shared.symbol === declared.symbol) : null;
            sharedByKey.set(declared.key, existing ?? this.sharedParameter({
                symbol: declared.symbol, name: declared.name, value: declared.value, unit: declared.unit ?? '',
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
            const bindings = this.#helpers.reconcileEquationBindings([], fromNode, toNode, parameters);
            const validation = this.#helpers.validateEquationLatex(edge.latex, bindings);
            if (!validation.valid) throw new Error(`Bundle "${template.id}" edge "${edge.name}" has an invalid equation: ${validation.errors.join(' ')}`);
            const portState = (node, role, ports) => node.states.find((state) => state.symbol === (edge.output.role === role ? edge.output.state : [ports].flat()[0]));
            const outputNode = edge.output.role === 'source' ? fromNode : toNode;
            this.edges.push({
                id: this.id(), name: label ? `${edge.name} — ${label}` : edge.name,
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
        return sharedByKey;
    }

    document({ globalTimeStep, outputInterval, copyright = 'Copyright © 2026 Zenin Easa Panthakkalakath' }) {
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
