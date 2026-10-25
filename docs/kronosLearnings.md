---
type: Research Note
title: Kronos learnings for Konjugate and Konjugate Fintech
description: What the Kronos candlestick foundation model could teach base Konjugate and the Fintech toolbox, with next steps.
resource: https://github.com/shiyu-coder/Kronos
tags: [kronos, forecasting, ensembles, markets]
status: draft
implementation: not-started
generated: { by: claude-code/claude-sonnet-5-5, at: 2026-10-26T00:00:00Z }
sources:
  - id: kronos-readme
    resource: https://github.com/shiyu-coder/Kronos
    title: Kronos README
---

# Kronos learnings for Konjugate and Konjugate Fintech

Running document, started 2026-10-26. Source: the Kronos README[^kronos-readme]; we have not read its code or paper.

## What Kronos is

Kronos is an MIT-licensed family of foundation models for financial candlestick (OHLCV) data, trained on data from 45+ exchanges.[^kronos-readme]

- **Architecture:** a tokenizer turns OHLCV bars into hierarchical discrete tokens, then an autoregressive Transformer is pre-trained on them.
- **Sizes:** mini 4.1M params (context 2048), small 24.7M (512), base 102.3M (512), large 499.2M (512, weights not open).
- **Inference:** `KronosPredictor` normalizes, predicts, then inverse-normalizes. Only open, high, low, close are required. Sampling uses temperature, `top_p` and `sample_count` (number of forecast paths averaged); `predict_batch()` forecasts several series at once.
- **Fine-tuning and backtest:** Qlib-based pipeline on China A-share daily data, with a simple top-K demo strategy. The authors say a real system needs risk neutralization, costs, slippage and position sizing.
- **Publication:** arXiv 2508.02739, reported accepted at AAAI 2026.

## Core thesis

Kronos and Konjugate cover different halves of the problem, so the value is in composing them, not choosing one.

- **Kronos:** a black-box statistical forecaster of exogenous price paths, with no mechanics or conservation laws.
- **Konjugate Fintech:** a transparent, stock-flow-consistent model of endogenous mechanics: balance sheets, AMMs, liquidations, fire sales.

Kronos can supply realistic inputs; Konjugate shows what those inputs do to a system of institutions. Keeping Kronos an optional, labeled input protects the transparency pitch.

## Ideas for Konjugate Fintech

In the order we would weigh them.

1. **Benchmark the causal-graph forecaster against Kronos zero-shot.** `scripts/marketBacktest.mjs` already exists. If the transparent model matches or beats Kronos on some baskets, that is an honest selling point; if not, we learn where the graph falls short.
2. **Ensembles over sampled paths.** Kronos draws many paths per forecast. Running a branch tree over N sampled paths would give fan charts and a probability that a cascade triggers, not just whether it triggers at one shock size.
3. **Kronos paths as an exogenous driver.** In `defiLiquidationCascade` the outside reference price is a hand-stepped control. A sampled path could drive it, with the existing fork interventions injecting the stress on top.
4. **Echo its signal-versus-portfolio caveat.** The authors warn that raw predictions are not robust alpha. The same framing fits the Markets window help text.
5. **Per-window normalization.** Normalize each lookback window, model, then invert. This may help `packages/toolbox/lib/market.mjs` compare windows across regimes.

## Ideas for base Konjugate

The generic form of the ideas above belongs in core, so every plugin author benefits and the toolbox stays the first customer.

- **Pluggable external-forecaster provider.** A time-series source node whose values come from a provider (Kronos, a CSV, a live feed), with an ensemble-size parameter.
- **Ensemble and batch execution.** Run many sampled inputs as parallel branches, reusing checkpoint branching.

## Cautions and open questions

- **Runtime mismatch.** Kronos needs Python and PyTorch; Konjugate is Electron and JS with a native plugin. Start with an offline script that writes CSVs Konjugate already ingests, before considering a sidecar.
- **Narrow coverage.** It models OHLCV only, so it does not cover FRED rates or yields. Only mini has the 2048 context, and large is not open.
- **Tail events.** Stress tests live in tails that are thin in training data. Use Kronos for baseline dynamics, not to define the shock.
- **Transparency pitch.** Keep it an optional, clearly labeled input.
- **Not verified:** how Konjugate currently handles stochastic inputs or the Markets forward run. We read the ReadMe, not the engine or `lib/market.mjs`.
- **Open:** does Kronos zero-shot work on the basket types in `packages/toolbox/samples`?

## Next steps

Start with the benchmark: it is cheap and tells us whether the rest is worth building.

- [ ] Run Kronos zero-shot on the sample baskets and compare with the causal-graph forecast via `marketBacktest.mjs`
- [ ] Read how the Markets forward run and engine handle stochastic inputs
- [ ] Prototype ensemble branches over sampled paths on `defiLiquidationCascade`
- [ ] Decide whether a core forecaster-provider interface is worth proposing

## Log

| Date | Entry |
| --- | --- |
| 2026-10-26 | Reviewed the Kronos README against the Fintech ReadMe; wrote this document. No code changed. |

[^kronos-readme]: [Kronos README](https://github.com/shiyu-coder/Kronos), read 2026-10-26.
