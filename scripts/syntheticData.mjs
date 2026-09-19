/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Fictional interbank data of any size, for testing how the importer and the model scale. A few large
// institutions lend to and borrow from most others; small ones deal mainly with the large ones (a
// core-periphery network, the shape usually reported for interbank markets). Balance sheets balance by
// construction. Deterministic for a given seed.

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function syntheticData({ institutions: count, seed = 1, coreShare = 0.2 }) {
    const random = seeded(seed);
    const names = Array.from({ length: count }, (_unused, index) => `Bank ${String(index + 1).padStart(2, '0')}`);
    const assets = names.map(() => Math.round(10000 * Math.exp(random() * 3.4)));
    const order = [...assets.keys()].sort((left, right) => assets[right] - assets[left]);
    const coreSize = Math.max(2, Math.round(count * coreShare));
    const core = new Set(order.slice(0, coreSize));
    const matrix = Array.from({ length: count }, () => new Array(count).fill(0));
    for (let lender = 0; lender < count; lender += 1) {
        for (let borrower = 0; borrower < count; borrower += 1) {
            if (lender === borrower) continue;
            const bothCore = core.has(lender) && core.has(borrower);
            const oneCore = core.has(lender) || core.has(borrower);
            if (random() < (bothCore ? 0.9 : oneCore ? 0.35 : 0.04)) matrix[lender][borrower] = Math.round(assets[lender] * (0.004 + random() * 0.02) / 100) * 100 || 100;
        }
    }
    const rows = names.map((name, index) => {
        const lent = matrix[index].reduce((total, value) => total + value, 0);
        const borrowed = matrix.reduce((total, row) => total + row[index], 0);
        const equity = Math.round(assets[index] * 0.06);
        const total = Math.max(assets[index], lent + borrowed + equity + 1000);
        const deposits = total - borrowed - equity;
        const cash = Math.round(0.11 * deposits);
        return { name, cash, loans: total - cash - lent, lent, deposits, borrowed, equity };
    });
    const institutionsCsv = ['institution,cash_and_reserves,loans_and_securities,interbank_assets,deposits_and_other_liabilities,interbank_liabilities,equity',
        ...rows.map((row) => [row.name, row.cash, row.loans, row.lent, row.deposits, row.borrowed, row.equity].join(','))].join('\n') + '\n';
    const exposures = ['lender,borrower,amount'];
    matrix.forEach((row, lender) => row.forEach((amount, borrower) => { if (amount) exposures.push(`${names[lender]},${names[borrower]},${amount}`); }));
    return { institutionsCsv, exposuresCsv: `${exposures.join('\n')}\n`, exposureCount: exposures.length - 1 };
}
