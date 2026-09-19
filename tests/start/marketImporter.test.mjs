/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import importData from '../../packages/markets/importers/marketSeries.mjs';
import { konjugateModule } from '../../scripts/konjugatePaths.mjs';

const { applyAssistantProposal } = await import(pathToFileURL(konjugateModule('src/assistantOperations.mjs')));
const helpers = {
    applyOperations(operations) {
        const empty = { format: 'konjugate', version: 1, copyright: '', metadata: { units: 'SI' }, runConfigurations: [], sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: [] };
        const { document, temporaryReferences } = applyAssistantProposal(empty, { proposalVersion: 1, operations });
        return { document, references: temporaryReferences };
    }
};

let seed = 5;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
const market = Array.from({ length: 300 }, () => 0.01 * normal());
const airlines = market.map((value) => 1.2 * value + 0.008 * normal());
const oil = airlines.map((value) => -0.8 * value + 0.02 * normal());
const file = (name, returns) => {
    let price = 100;
    return { role: 'series', name: `${name}.csv`, encoding: 'utf-8', text: `Date,Close\n${returns.map((change, index) => `${new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)},${(price *= Math.exp(change)).toFixed(6)}`).join('\n')}\n` };
};
const files = [file('Market', market), file('Airlines', airlines), file('Oil', oil)];
const together = (source, target, coefficient) => ({ sourceColumn: source, targetColumn: target, lag: 0, terms: [{ degree: 1, coefficient }], intercept: 0, score: 0, provenance: 'correlationOnly' });

test('same-bar links read the source\'s push, not its return, so a shock never chains through a middle series', async () => {
    const result = await importData({ files, helpers, options: { stage: 'build', edges: [together('Market', 'Airlines', 1.3), together('Airlines', 'Oil', -5)], selfTerms: [] } });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    const links = result.document.edges.filter((edge) => edge.name.includes('⇄'));
    assert.equal(links.length, 2);
    assert.ok(links.every((edge) => /sourcePush/.test(edge.equation) && !/sourceRet/.test(edge.equation)), 'A same-bar link is driven by the source\'s push.');
    // Each link is refitted against the kept sources, not taken from the engine's conditional coefficient (1.3 and -5 were made up).
    const coefficient = (name) => Number(links.find((edge) => edge.name === name).equation.replace(/[^0-9.-]/g, '').match(/-?[0-9.]+/)[0]);
    assert.ok(Math.abs(coefficient('Market ⇄ Airlines') - 1.2) < 0.15, `The market beta of airlines is refitted to about 1.2 (${coefficient('Market ⇄ Airlines')}).`);
    assert.ok(Math.abs(coefficient('Airlines ⇄ Oil') - -0.8) < 0.25, `The beta of oil on airlines is refitted to about -0.8 (${coefficient('Airlines ⇄ Oil')}).`);
    // The forcing goes to both the return and the push through edges that share their controls.
    const pushEdge = result.document.edges.find((edge) => edge.name === 'Shock push → Airlines');
    const returnEdge = result.document.edges.find((edge) => edge.name === 'Shock → Airlines');
    assert.deepEqual(pushEdge.parameters.map((parameter) => parameter.sharedParameterId), returnEdge.parameters.map((parameter) => parameter.sharedParameterId));
    assert.deepEqual(result.parameterIndex.filter((entry) => entry.entity === 'Airlines').map((entry) => entry.key).sort(), ['drive', 'shock', 'trackGain']);
});

test('the fitted drift of a link is left out of the model unless asked for', async () => {
    const edge = { sourceColumn: 'Airlines', targetColumn: 'Oil', lag: 1, terms: [{ degree: 1, coefficient: 0.3 }], intercept: 0.0123, score: 0.1, provenance: 'continuousLagged' };
    const without = await importData({ files, helpers, options: { stage: 'build', edges: [edge], selfTerms: [] } });
    const withDrift = await importData({ files, helpers, options: { stage: 'build', edges: [edge], selfTerms: [], keepIntercepts: true } });
    const equation = (result) => result.document.edges.find((item) => item.name === 'Airlines → Oil').equation;
    assert.ok(!/0\.0123/.test(equation(without)));
    assert.match(equation(withDrift), /0\.0123/);
});
