/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Checks the market stability analysis against Konjugate's real inference engine on synthetic returns: one series
// leads another by a known lag, the others are noise. A planted link should be found steadily; noise should not.
// Usage: node scripts/marketStability.mjs [bars] [windowLength]
import { pathToFileURL } from 'node:url';
import { konjugateDir, konjugateModule } from './konjugatePaths.mjs';
import { analyzeWindows, toChanges } from '../packages/markets/lib/market.mjs';

const { inferWithEngine } = await import(pathToFileURL(konjugateModule('src/engineAdapter.mjs')));
const bars = Number(process.argv[2] ?? 400);
const length = Number(process.argv[3] ?? 120);
let seed = 12345;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());

const names = ['Crude', 'Airlines', 'Gold', 'Miners', 'Noise1', 'Noise2'];
const returns = names.map(() => []);
for (let bar = 0; bar < bars; bar += 1) {
    const crude = normal();
    const gold = normal();
    returns[0].push(crude);
    returns[2].push(gold);
    returns[1].push((bar >= 2 ? -0.6 * returns[0][bar - 2] : 0) + 0.8 * normal());  // crude leads airlines, lag 2, negative
    returns[3].push((bar >= 1 ? 0.5 * returns[2][bar - 1] : 0) + 0.8 * normal());   // gold leads miners, lag 1, positive
    returns[4].push(normal());
    returns[5].push(normal());
}
const dates = Array.from({ length: bars }, (_, index) => `d${String(index).padStart(4, '0')}`);
const changes = { names, dates, columns: returns, kinds: names.map(() => 'difference') };
const options = { applicationPath: konjugateDir, resourcesPath: '', packaged: false, signal: undefined };
const started = Date.now();
const result = await analyzeWindows(changes, { length, count: 8 }, async (csv, config) => {
    const inferred = await inferWithEngine(csv, config, options);
    if (!inferred.available) throw new Error('Engine not found. Build it first, or set KONJUGATE_ENGINE_PATH.');
    return inferred.report;
});
console.log(`${result.windows.length} windows of ${length} bars over ${bars} bars, ${Date.now() - started} ms`);
for (const link of result.links) {
    console.log(`${link.source} -> ${link.target}: in ${link.appearances}/${link.windows} windows, sign ${link.sign > 0 ? '+' : '-'} (${(link.signAgreement * 100).toFixed(0)}%), lag ${link.lag} (${(link.lagAgreement * 100).toFixed(0)}%), ${link.label}`);
}
