# Konjugate Fintech Toolbox

A closed-source, commercial extension for [Konjugate](https://github.com/zenineasa/Konjugate) — an open-source, graph-native simulation engine — bringing that engine's state-and-flow modeling to quantitative finance, decentralized finance (DeFi), systemic risk stress-testing, and macroeconomics.

Revenue from this toolbox funds full-time development of Konjugate's open-source core. See [Sustainability model](#sustainability-model) below for how that's structured.

## Status

Early development. What exists today, all verified end to end against a real Konjugate build:

- A component-library plugin (`konjugate.fintech.engine`) with five node templates (commercial bank, depositor wallets, central bank, asset market, AMM liquidity pool), one edge template (liquidity flow) and five **bundles** — a deposit run, a fire sale, interbank lending, interbank default and emergency lending — that wire up several edges at once with the parameters they must agree on shared between them.
- One reference model, `interbankLiquidityRun`: three banks, a depositor run on one of them, fire-sale and interbank-lending contagion, defaults that pass an insolvent bank's shortfall to its creditors, and a central bank that can lend to the distressed bank. Every balance sheet balances (reserves + loans + interbank claims = deposits + equity + interbank borrowing) and total money is conserved at every step. In the baseline bank A is driven insolvent around day 50 and its creditors' equity falls from 50 to about 20. Forking the run at day 12 shows two counterfactuals: emergency lending keeps bank A solvent (equity 45, creditors near 49), while a fire-sale haircut shock (0.10 to 0.25) tips the creditors into insolvency as well. The default channel is a stylized version of Eisenberg-Noe — losses flow to creditors in fixed shares, not through a solved clearing vector — and interbank lending is one-way, with no maturities or repayment.
- An interaction test that wires the same model up from the bundles alone and checks it reproduces the script-built model's every state, in the baseline and in the fork.

Everything else described below — the numerical plugin, the visualizer add-on, the remaining reference scenarios, the data pipeline — is planned, not built.

## Why this exists

Modern quantitative finance is fragmented across paradigms that don't compose well:

- **Spreadsheets and macro models** are static and linear — they can't express non-linear feedback loops or multi-scale delays.
- **Pure agent-based models** are computationally heavy, hard to validate formally, and often black boxes.
- **Equation-only dynamic models** are hard to compose or inspect spatially across institutions, collateral tiers, and counterparties.

Financial systems are, underneath, networks of balance sheets, capital flows, and contractual obligations — which is exactly what Konjugate's graph-native, state-and-flow engine already models well. The mapping is direct, not metaphorical:

| Physical concept | Financial analog |
|---|---|
| Mass / energy conservation | Double-entry accounting invariance |
| State variable | Balance sheet account / inventory |
| Potential / voltage | Price, yield, or valuation gradient |
| Resistance / friction | Transaction costs, slippage |
| Capacitance | Liquidity buffers, capital reserves |
| Fluid flow / conduction | Transaction velocity, payment flow |
| Algebraic state | Bonding curves, mark-to-market valuation, solvency bounds |

Because transactions are modeled as conservative bidirectional edges, models built this way are **stock-flow consistent by construction** — the "leaky money" bugs that plague bespoke financial simulators can't happen here.

## What's in the toolbox

Three coordinated packages, following Konjugate's existing plugin/add-on/package split:

| | Numerical plugin (`.kjp`) | Visualizer add-on (`.kja`) | Pre-built suite (`.kjt`) |
|---|---|---|---|
| **Role** | The quantitative engine | The risk & trading cockpit | Ready-to-run reference models |
| **Contains** | SDEs (GBM, Ornstein-Uhlenbeck), Eisenberg-Noe interbank clearing, Avellaneda-Stoikov market making, Black-Scholes Greeks | Systemic contagion Sankey diagrams, Basel III CAR/LCR gauges, AMM depth/slippage explorer, liquidity phase portraits, live stress-test controls | Interbank contagion, DeFi liquidation cascade, macro business cycle, cross-market commodity transmission |
| **Runs as** | Native code in the engine's provider runtime, install-time trust (hash-pinned artifact, no runtime sandbox — the same model most native desktop plugin systems use, and the right performance tradeoff for compute-heavy quant workloads) | Electron's isolated renderer, `contextBridge`/`ipcRenderer` only | Loaded directly onto the canvas |

Component templates install as ordinary plugin-contributed component-library entries — no changes to Konjugate's core files are needed to add a `Finance` domain to the sidebar. Three kinds ship: **nodes** (a bank's balance sheet, the depositors' cash, a central bank, an asset market, an AMM pool), **edges** (a conservative liquidity flow) and **bundles**. A bundle is one library entry that stamps out several edges among several selected nodes as a single undoable step, with the parameters those edges must agree on declared once and shared. The five finance bundles are the reason the toolbox needs them: a deposit run moves a bank's reserves and its deposits by the same amount through two matched edges; a fire sale converts loans to reserves at a price that falls as the market fills, hitting equity by the shortfall, with the base haircut as a live stress control; interbank lending moves reserves, the lender's claim and the borrower's liability together; interbank default writes an insolvent borrower's debt down and charges the same amount to each creditor's claims and equity; emergency lending is one live slider (or one fork intervention) that drives both legs of a central bank's facility. Applying a bundle can never leave a balance sheet unbalanced or two edges disagreeing about a constant, which is exactly the class of bug hand-built financial simulators suffer from.

## Core financial models

Each of these is a concrete, testable mathematical model, not a hand-wave:

- **Commercial bank runs** — deposit withdrawal dynamics, tiered liquidation (reserves first, then fire-sale of the loan book at a haircut), Basel III CAR and LCR as derived states.
- **AMM constant-product pools** — spot price, fee-adjusted swap dynamics, external-reference arbitrage flow.
- **DeFi lending vaults** — utilization-indexed kinked borrow/supply rate curves (Aave/Compound-style).
- **Interbank contagion (Eisenberg-Noe)** — relative liability shares, clearing payment dynamics, default-driven write-downs cascading to creditors.
- **High-frequency market making (Avellaneda-Stoikov)** — inventory-aware reservation price, optimal bid/ask spread.
- **Central bank policy (Taylor rule)** — inflation- and output-gap-driven rate setting, transmitted to bank reserves via open-market operations.

Full derivations live in the model implementations; this ReadMe stays at the "what and why" level.

## Engine capabilities this leans on

All of these are core, generic Konjugate capabilities — this toolbox is simply the first paying customer motivated enough to fund some of the ones that didn't exist yet (see [Roadmap](#roadmap)).

- **Multi-rate substepping** — fast dynamics (HFT order routing, AMM arbitrage) run at hundreds to thousands of substeps per global step; slow dynamics (macro policy, loan amortization) advance at the global step.
- **Causal inference** — discovers a hidden transmission network directly from historical multivariate time series (yields, spreads, prices), via lagged partial-correlation screening plus ridge regression, with optional non-linear interaction terms.
- **Stability monitoring** — real-time eigenvalue and oscillation detection, flagging flash-crash-like or stablecoin-death-spiral dynamics before divergence.
- **Parameter fitting** — calibrates behavioral parameters (risk aversion, market depth, fire-sale haircuts) against historical stress events via NLopt.
- **Shared parameters** — one project-level parameter that any number of edges and source terms link to, so a single value, a single live control or a single fork intervention drives all of them. Constants that many relationships must agree on (a reserve target, a fire-sale haircut, a withdrawal rate) live in one place, and a parameters table shows every parameter in the model with what it belongs to and lets you edit it in place. Built, tested, and used by every finance bundle.
- **Component bundles** — the library entry described above: several edges among several nodes, with shared parameters, in one undoable step; nodes are matched to roles by the states they have, not by click order. Built, tested, and used by every finance bundle.
- **Checkpoint branching ("Fork here")** — the flagship regulatory stress-testing interaction: scrub to any point in a completed run, fork into a new branch, optionally apply a step/ramp/pulse/piecewise parameter intervention, and compare any number of branches side by side. This is a fully built, tested capability — checkpoints are captured at every output boundary (not just a run's start and end), interventions are evaluated at substep-accurate granularity, forks form a real tree (forks of forks), and an entire branch tree persists in and reloads from a saved project file.

## Reference scenarios

Four flagship demo models are the intended first showcase of the trio above. Only the first exists, and only in part; the rest are the concrete target, not a claim of current state:

1. **Interbank contagion** — a shock to one bank cascades through bilateral exposures; forking at the shock and injecting central-bank liquidity shows the counterfactual. *Largely built* as `interbankLiquidityRun`: the run, the fire-sale and interbank channels, the default cascade, and both forks (a policy response and a fresh shock) work today. What is missing is a solved Eisenberg-Noe clearing vector in place of the fixed credit shares, and maturities and repayment on interbank loans.
2. **DeFi liquidation cascade** — an ETH price drop breaches a leveraged borrower's LTV, triggering liquidation that further depresses the AMM price and cascades to other borrowers.
3. **Macro business cycle** — a supply shock, a Taylor-rule rate response, and the resulting multi-month transmission lag into investment and inflation.
4. **Cross-market commodity transmission** — a real, causal-inference-derived network (crude oil, gold, yields, USD, sector ETFs) driving a forward-simulated shock-propagation forecast.

## Market data & forecasting pipeline

A secondary, higher-effort capability: ingest a multi-asset basket from a market data provider, harmonize trading calendars, transform to stationary log-returns or cointegrated spreads, run causal inference to materialize a data-driven model, then forward-simulate with branch-based scenario forking for "what if" analysis. This turns the causal inference engine into a forecasting tool, not just a model-authoring aid.

## Target customers

| Segment | Use case | Offer |
|---|---|---|
| Hedge funds & prop desks | Cross-market causal forecasting, HFT market-making simulation, stat arb | Per-seat developer license, C++ SDK, priority support |
| Commercial & investment banks | Basel III stress-testing, interbank contagion modeling, counterparty risk | Enterprise site license, custom risk connectors, SLA |
| Central banks & regulators | Macro business cycle modeling, systemic contagion analysis, policy transmission forecasting | Multi-year institutional deployment, modeling workshops |
| DeFi protocols & Web3 treasuries | AMM design, liquidation resilience audits, tokenomics stress-testing | Protocol security audit license, tokenomics package |

No beachhead has been chosen among these yet — that's an open decision, not an oversight.

## Sustainability model

Konjugate's core stays MPL-2.0: free, transparent, and open for academic, engineering, and student use. This toolbox is the commercial counterpart — sold to institutions, funding full-time core engineering, GPU/CUDA solver development, and documentation. MPL-2.0's file-level copyleft is what makes this legally clean: only *modifications to core files* must stay open; independent files, packages, and processes that communicate with the core through stable interfaces (this toolbox's `.kjp`/`.kja`/`.kjt`) are a "Larger Work" and can be proprietary. Every integration point here — the plugin's C ABI boundary, the add-on's `contextBridge` boundary, the plugin-contributed component templates — was chosen specifically to keep that boundary clean without needing a single core-file edit.

## Repository relationship to Konjugate

This is an independent repository, not a subdirectory or submodule *of* Konjugate — the dependency runs the other way: this repo will reference the public [`Konjugate`](https://github.com/zenineasa/Konjugate) repo (via a git submodule or pinned release tag) to build its native plugin against the public engine ABI. Keeping the repos separate means proprietary code here can never end up in the public repo's git history by accident.

At runtime, none of this lives "inside" Konjugate's own source either — the `.kja`/`.kjp` packages built here get *installed* into a user's `<userData>/packages/addons/...` and `.../packages/plugins/...`, the same way any third-party Konjugate extension would be. For local development, that means: build here, install the output into a local Konjugate's `userData/packages/` directory, and test against a real running instance — no special integration needed on Konjugate's side.

## Development

The two repositories are expected to sit side by side (`../konjugate`, or point `KONJUGATE_DIR` at a checkout that has been built with `npm run build:engine`). Everything below uses Konjugate's own package, validation and project-file code, so what passes here is what the real app accepts.

- `npm run build` — builds `packages/engine` into `out/konjugate.fintech.engine-<version>.kjp`.
- `npm run install:dev` — builds, then installs into your local Konjugate's `userData/packages` (override with `KONJUGATE_USER_DATA`).
- `npm run build:models` — regenerates the reference models in `models/` from `scripts/buildModels.mjs`, so a model's structure is reviewable in git.
- `npm test` — fast unit tests: every component template and bundle passes Konjugate's template validator.
- `npm run test:interaction` — launches the real Konjugate app with a scratch user-data directory (never yours), installs the built plugin, runs the reference model, forks it twice (emergency lending and a haircut shock), and wires the same 55-edge model up from the bundles through the real UI to check the two agree state for state. Konjugate's own interaction runner cannot be extended from outside, so this is an independent Playwright harness.

## Roadmap

**Phase 1 — Component library & shape catalog.** Ship the `finance` domain's component templates as a `.kjp` with `contributes` entries. *Substantially built*: nodes, an edge and four bundles for the bank-run and contagion family. Not yet: the AMM and lending-vault bundles (constant-product swap with fees, external arbitrage flow, utilization-indexed borrow and supply rates), and a shape catalog. Reaching this needed two core Konjugate features, shared parameters and component bundles, both now built and open source; the plugin itself needed no core file edits.

**Phase 2 — Reference models & verification.** Build the four scenarios above as `.kjt` files with companion guides and numerical regression coverage. *One largely built* (see above).

**Phase 3 — Visualizer add-on.** The risk cockpit: Sankey loss-flow diagrams, regulatory ratio gauges.

**Phase 4 — Market data importer & causal inference pipeline.** Multi-ticker ingestion, log-return/cointegration transforms, end-to-end causal inference reconstruction, forward simulation with scenario forking.

**Core-platform items this toolbox needs but that benefit every Konjugate plugin/add-on author** (not fintech-specific — this vertical is just the first funded customer):

| Item | Scope | Status |
|---|---|---|
| Compiled/stripped native plugin distribution | Moderate — the in-process ABI it needs already exists; needs a precompiled-artifact install path plus a per-platform build/sign/strip CI pipeline | Not built |
| Package licensing/entitlement verification (Ed25519) | Largest of the three — no existing primitive, a genuine new subsystem (issuance, offline verification, expiration, status UI) | Not built |
| Package-identifier namespace reservation | Small — closer to npm scopes than an app-store review, near a one-file addition to the open-source repo | Not built |
| Shared parameters | Medium — a project-level parameter that many edges and source terms link to, resolved by the engine, with a parameters table and undoable editing | **Built** |
| Component bundles | Medium — one library entry that creates several edges among several nodes with shared parameters, as one undoable step | **Built** |
| Tunable shared parameters | Medium — let a shared parameter be a fitting target, so calibration acts on the behavioral constants many edges share; needs a change to the engine's parameter-fitting module | Not built |

## License

Proprietary. All rights reserved. Not licensed under Konjugate's MPL-2.0 — see [Sustainability model](#sustainability-model) for why that split is intentional and legally deliberate.

---

Copyright © 2026 Zenin Easa Panthakkalakath
