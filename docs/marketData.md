# Idea: live market data, rolling causal analysis and simulating ahead

Status: idea, not built. Recorded so it is not lost. Nothing here is committed to.

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

## Open questions

- Which causal method to use on time series (lagged regression, Granger-style tests, transfer entropy, or what Konjugate's causal inference already provides), and how to keep it honest about instability.
- Whether simulating ahead uses the inferred relationships directly or first fits parameters to the window.
- Where the refresh scheduler lives, and what happens to a rebuild that is running when the window closes.
- Whether the rebuilt models should be kept as a history the user can compare, and for how long.
