# Idea: live market data, rolling causal analysis and simulating ahead

Status: a first version is built as the Markets window (`packages/markets`), separate from the Start window, with its own toolbar button. It reads price and rate files or fetches them from Yahoo Finance, FRED and Stooq, finds links over rolling windows, builds a model from the links you keep, runs a what-if from the latest bar, and can reload and rebuild on demand or on a timer while the window is open. What follows was the plan; "What was built and what real data showed" at the end records how it turned out.

## The idea

Let the toolbox pull stock, FX and commodity data on its own, infer the causal structure between the series over a window of time the user chooses, turn that structure into a Konjugate model, and simulate ahead from the latest state. Rebuild the model every x minutes so the structure follows the market.

This gives the toolbox a way to be useful before an institution shares any of its own data, and it reuses what Konjugate already does: causal inference, fitting to data, and forking a run from a checkpoint to test an intervention.

## The flow

1. **Choose a universe.** A list of tickers or commodities (for example Brent crude, a few airline and energy stocks, a rates series), a bar size (daily, hourly, five-minute) and a window (for example the last 90 days). The window is the user's to set, since it changes the answer a lot.
2. **Import.** Fetch the bars, align timestamps across series, handle holidays, gaps and different trading hours, and convert prices to returns or another stationary form before analysis.
3. **Infer.** Run causal inference on the window: which series lead which, with what lag and sign, and how strongly. Report the confidence and the lag with each link, not only the arrow.
4. **Build.** Turn the inferred graph into a Konjugate model, one node per series, with the latest observed values as the starting state.
5. **Simulate ahead.** Fork from the latest state, apply an intervention ("crude oil +10%", "rates +50 bp") and show how the series respond, against a baseline with no intervention.
6. **Refresh.** Every x minutes, refetch, re-run the analysis on the rolling window and rebuild. Keep the earlier models so the user can see how the inferred structure changed.

## Where the data comes from

| Source | Covers | Notes |
| --- | --- | --- |
| Yahoo Finance | Equities, FX, futures, crypto | Free and broad, but no official API and terms that restrict commercial use. Fine for a demo, risky for a product. |
| Stooq | Equities, indices, FX, commodities | Free CSV download, daily bars. |
| FRED | Rates, macro series, some commodities | Free with a key, reliable and documented. |
| Central-bank feeds (ECB and others) | FX reference rates, policy rates | Free, official. |
| Alpha Vantage, Twelve Data, Polygon | Equities, FX, crypto | Keyed, with free tiers; better terms than scraping. |
| Binance or Coinbase public endpoints | Crypto | Free, intraday. |
| A file from the user's own data team | Anything | The default for a real institution. Bloomberg and Refinitiv exports arrive this way. |

The importer should take a pluggable source, so a practitioner can point it at what they already license. File import stays the baseline; live feeds are opt-in.

## Where it fits

- It lives in the fintech add-on as a "Markets" track beside the balance-sheet track in the Start window, not in Konjugate core.
- Two pieces are generic and could go into Konjugate core as neutral features: re-running an analysis on a schedule, and a rolling analysis window. Neither needs any finance in it.
- The existing causal inference and fork-from-checkpoint features do the analysis and the simulation.

## Constraints and risks

- **Network access.** Today the promise is "everything stays on this computer", and importers run in a sandboxed worker with no network. A live fetch needs a new, explicit permission in the add-on manifest (for example `network.fetch`, with the allowed hosts listed), performed by the add-on host and not the worker, and the window must say plainly when it is fetching. A user should be able to run the whole track from files with no network at all.
- **Causality on markets is fragile.** Market series are noisy, non-stationary and heavily correlated, and the inferred graph will change with the window length and from one refresh to the next. The tool has to show how stable each link is across windows and refreshes, or a practitioner will rightly dismiss it. How stable a link is may be the most useful output.
- **Simulation is not forecasting.** Present "simulate ahead" as scenario exploration from the latest state, with the assumptions visible, especially for a finance audience.
- **Data licensing.** Free sources have terms. Keep the source visible in the run manifest and do not redistribute fetched data.
- **Cost.** A handful of series rebuilds in seconds. Hundreds of tickers will not, so cap the universe or the analysis time, and say so.
- **Data quality.** Splits, dividends, stale quotes, missing bars and time zones all change results. The importer must report what it repaired or dropped, in the way the balance-sheet importer reports its problems.

## A first version

- A market importer that reads files and Stooq or FRED, with a window setting.
- Causal analysis with lag, sign, confidence and a stability indicator.
- A "Rebuild now" button, one what-if fork, and the model opened in the canvas.

Automatic refresh, the network permission and Yahoo come only if the first version gets a reaction.

## Questions for practitioners

- Would live market data matter to you, or would you only ever use your own data?
- Which feed would you trust, and which would your security or compliance team allow?
- How would you use a causal graph of market series: monitoring, hedging, scenario design, or not at all?
- How often would you want it refreshed, and over what window?
- What would make you trust a link between two series?

## What the first checks showed

Checked against Konjugate's real inference engine with `scripts/marketStability.mjs`, on synthetic returns where one link is planted (gold leads miners by one bar, positive) and the rest is noise.

- **Same-bar pairs must be left out.** The engine also reports pairs that move together in the same bar, with no time order (provenance `correlationOnly`). On noisy returns these appeared in most windows, in both directions, and would have been labelled "stable". Only lead-lag links (lag of one bar or more) are counted.
- **Overlapping windows overstate stability.** Windows that share bars count one chance correlation many times, so windows do not overlap by default, and a result from overlapping windows says so.
- **The default skeleton threshold is too loose for short noisy windows.** A partial correlation from n bars varies by about 1/sqrt(n), so the threshold is raised to two standard errors of the window length.
- **With those three in place**, 8 non-overlapping windows of 150 bars found the planted link in 6 of 8 with its sign and lag correct every time, labelled "sometimes"; two noise links each appeared in 1 of 8 windows and were labelled "unstable". A real but modest effect is not reliably found in every window, which is what the stability label is for.
- **A known blind spot in core.** A planted link at a lag of two bars (crude leads airlines) was not found, because the first screening stage in core looks at one-bar lags only. For daily market data this matters little, since lead-lag beyond a day is rare, but the window must say that links longer than one bar may be missed. Whether to widen the screening in core is a question for the core inference, to be raised only if a real dataset needs it.

## Open questions

- **Causal method: decided, use what Konjugate already has.** Core inference (a lagged partial-correlation skeleton, then per-target lagged ridge regression chosen by chronological held-out score) is close to a multivariate Granger approach and is judged on out-of-sample prediction. Do not add transfer entropy, separate Granger tests or other methods to core for this: transfer entropy needs far more data than a market window gives, and the others largely restate the held-out score. Add a second method through the existing `skeletonMethod` seam only if a real dataset shows the current one failing.
- **Instability: handled in the add-on, not in core.** Call core inference repeatedly on rolling windows and on resampled blocks, and report for each link how often it appears, whether its sign and lag hold, and how it changes between refreshes. Return-conversion, stationarity checks, volatility normalisation and trading-hour alignment also stay in the add-on, before the data reaches core.
- **Possible later core additions, if several add-ons need them:** inference over rolling windows with per-edge stability, and a stability or significance number on each edge.
- **Simulating ahead: decided for now, use the inferred relationships directly.** One bar is one unit of model time, and the model is run forward from the latest observed values. Fitting parameters to the window afterwards (Konjugate's parameter fitting) is a later option, not part of the first version. One thing must be checked when it is built: core inference recovers discrete lag coefficients, and the model treats each edge as a rate, so a forward run reproduces the fitted recurrence only approximately, and without damping on a node's own past. The first version must test how far a forward run departs from the data on a window it was fitted to, and state the result next to every simulation.
- **Refresh: decided for now, it runs only while the Start window is open.** A timer in the add-on host triggers the rebuild. A tick that arrives while the previous rebuild is still running is skipped, not queued, and the window says so. The shortest interval offered is five minutes. Nothing runs in the background when the window is closed.
- **History: decided for now, keep the last 20 rebuilds in memory for the open window, and write them out with the export.** Each entry records its window, the links found and their stability, so the user can see how the structure moved. Nothing is kept between sessions unless the user exports it.

## What was built and what real data showed

**Built.** The importer reads files (Stooq, FRED, Yahoo-style, European formats) or Yahoo's JSON, aligns the series, and turns them into changes. The window runs core inference on up to eight non-overlapping stretches, shows lead-lag links and same-bar co-movement in two tables with how steadily each appears, and builds a model from the ticked links. Three what-ifs shock one series or all of them from the latest bar. Fetching is a generic core permission (`network.fetch`) that reaches only the hosts named in the manifest, over https, with size and time limits, and records each address and time in the run manifest. Reload-and-rebuild keeps the last 20 looks and shows which links appeared or disappeared. The pieces core gained are generic: importer file roles that accept several files, options passed to an importer, an importer that returns only data, construction operations for importers, `analysis.infer` and `network.fetch`.

**Simulate-ahead fidelity, checked.** On synthetic data with a planted link, a 0.10 shock to the driver moved the follower by 0.0466, against 0.0456 implied by the fitted rate and 0.05 implied by the planted coefficient. The forward run reproduces the fitted link to within a few percent; the shortfall against the planted value is the estimate being a little small, not the model drifting. Each return relaxes towards zero (at the fitted rate, or within a bar if none was found), because a shock to a series with no memory would otherwise carry on for ever.

**Real data (Yahoo Finance, five years of daily bars, seven series: Brent, airlines, gold, gold miners, the ten-year yield, banks, the S&P 500).**
- **Lead-lag links: almost none.** In stretches of 60, 120 and 250 bars there was no lead-lag link in any stretch except one unsteady gold-miners-to-gold link. Liquid daily markets rarely lead each other by a whole bar, so the honest answer is "nothing reliable", and the window says so. Series that trade at different hours, slower macro series, or intraday bars are likelier to show leads and lags; that has not been tested.
- **Same-bar co-movement: steady and sensible.** Gold to gold miners appeared in all five 250-bar stretches with a beta of about 1.4, banks with airlines in four of five, the index with airlines in three of five. A what-if on this data (a 5% fall in gold) moved gold miners by 6.6% after 21 bars, in line with the known beta, and nothing else.
- **What this changes.** A tool built only on lead-lag would show nothing on real daily data. The co-movement table is what makes the what-if useful, but it cannot say which series drives which, so the window ticks the direction into the more volatile series and lets the user change it. It should be presented as a beta-style what-if, not as cause and effect.
- **Sources.** Yahoo's chart endpoint answered without a key; its terms restrict commercial use. Stooq now puts a browser check in front of downloads and may refuse a program; the window reports that plainly. FRED did not answer from the test machine on the day it was tried.

**Not done.** Intraday bars, a check of the what-if against out-of-sample moves, longer lead-lag delays in core, and a suite package holding the Start and Markets windows together.
