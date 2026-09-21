/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes the synthetic sample series the Markets window ships with. They are made up: a common market factor,
// plus three lead-lag links planted on purpose (crude leads airlines, gold leads gold miners, changes in the ten-year
// yield lead banks), so the analysis has something real to find and something to leave alone.
// Usage: node scripts/marketSamples.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fintechRoot } from './konjugatePaths.mjs';

let seed = 20260919;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());

const bars = 520;
const market = Array.from({ length: bars }, () => 0.008 * normal());
const crude = Array.from({ length: bars }, () => 0.018 * normal());
const gold = Array.from({ length: bars }, () => 0.009 * normal());
const yieldChange = Array.from({ length: bars }, () => 0.05 * normal());
const airlines = crude.map((_, bar) => 0.6 * market[bar] + (bar ? -0.6 * crude[bar - 1] : 0) + 0.013 * normal());
const miners = gold.map((_, bar) => 0.5 * market[bar] + (bar ? 0.9 * gold[bar - 1] : 0) + 0.016 * normal());
const banks = yieldChange.map((_, bar) => 0.7 * market[bar] + (bar ? 0.011 * (yieldChange[bar - 1] / 0.05) : 0) + 0.011 * normal());
const spx = market.map((change) => change + 0.004 * normal());

const businessDays = [];
for (let date = new Date(Date.UTC(2024, 8, 23)); businessDays.length < bars; date = new Date(date.getTime() + 86400000)) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) businessDays.push(date.toISOString().slice(0, 10));
}
const prices = (start, returns) => { let price = start; return returns.map((change) => (price *= Math.exp(change))); };
const levels = (start, changes) => { let level = start; return changes.map((change) => (level += change)); };
const series = {
    'Brent crude': prices(80, crude), Airlines: prices(40, airlines), Gold: prices(2300, gold), 'Gold miners': prices(25, miners),
    'US 10y yield': levels(4.2, yieldChange), Banks: prices(60, banks), 'S&P 500': prices(5400, spx)
};
const directory = join(fintechRoot, 'packages', 'toolbox', 'samples');
await mkdir(directory, { recursive: true });
for (const [name, values] of Object.entries(series)) {
    const lines = ['Date,Close', ...values.map((value, index) => `${businessDays[index]},${value.toFixed(name === 'US 10y yield' ? 3 : 2)}`)];
    await writeFile(join(directory, `${name}.csv`), `${lines.join('\n')}\n`);
}
console.log(`Wrote ${Object.keys(series).length} series of ${bars} bars to ${directory}`);
