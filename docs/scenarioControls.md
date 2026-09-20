# User-controllable scenarios in Fintech Start: what we build

Status: built. The plan is kept as it was written, with the corrections and the record of what was built at the end ("What was built, and what changed on the way"). This is the plan for giving users real control over what is stressed and how hard, and for showing which assumptions drive a result. It came from a reviewer's concern that the four scenarios are fixed and the only input is which institution to stress, and from read-only checks on the sample data. Everything below is in scope.

## Why

- The four scenarios are fixed in `packages/start/addon.json`: a depositor run (1.5% of deposits a day for 8 days on one institution), the same run with a 50% forced-sale haircut, that run and haircut with central-bank support, and a market-wide run (0.7% a day for 10 days). All fork at day 5 and run 60 days. The window can pass an entity, a run length and supplied data, but not parameter values.
- The contagion demo rests on three hand-picked numbers, and the biggest lever is one we made up. In the severe scenario, halving the reserve-target share means nobody fails and total damage falls 86%; raising it by half makes seven fail and damage rises 35% (an earlier figure of all eight and +157% scaled each institution's already-capped target past the cash it holds, which the model does not do). Other constants matter less (fire-sale rate about ±25%, interbank flow rate about ±16%, panic sensitivity −11% and +5%, price impact −8% and +10%).
- The lending network changes the answer a lot. In the severe scenario Dune Bank loses 2,768 million with real exposures and 12,171 with estimated ones, Fir fails only with real exposures, and with no interbank lending only Alder fails.
- Breaking points are clean on the sample. With Alder run on at 1.5% a day for 8 days, nobody fails at a 10% haircut, Alder alone fails from 20%, three fail at 50%, and all eight at 70%.
- Runs are fast: a fork takes 0.2 s on 8 institutions, 0.8 s on 20 and 2.0 s on 40, so a Run button is right.

## Regression targets

With every control at its default, results must not change. Sample data, Alder Bank stressed:

| Scenario | Who fails | Total equity down |
|---|---|---|
| Depositor run | nobody | 8,615 |
| Severe price shock | Alder day 14, Holly 47.5, Fir 52.5 | 49,339 |
| Price shock with support | Alder only, day 48 | 13,169 |
| Market-wide run | nobody | 38,852 |

## Principles

- Honesty over drama. Defaults are never tuned to make a demo look impressive, and we do not decide what users may try: limits exist only where the model is undefined, and anything else is advice. Every control shows its default, anything changed is marked, every override is recorded in the run manifest, and the "uncalibrated" messaging stays.
- Core changes are generic and minimal: recording only, with no finance logic, and the open-core boundary in the ReadMe stays intact.
- Nothing changes for other add-ons. The Markets window clamps supplied values today and keeps doing so: any stricter validation applies only to controls the Start window declares for itself, and a test runs Markets before and after and requires identical results and manifest fields other than the new optional ones.
- Runs start from a Run button. There is no live dragging.
- Every existing element id and its visible text stay unchanged for the recording script: `#useSample`, `#toScenarios`, `[data-scenario]`, `#entityChoice`, `#runScenario`, `#panel-results`, `#headline`, `#resultTable`, `#anotherScenario`. New elements are additive and the controls panel is collapsed by default. The headline text changes only when a setting has been changed.
- The Markets window and both reference models keep working, and existing tests pass.

## The controls

**Limits.** Each control has a hard limit and an advisory band. The hard limit is the widest range where the model still works, and it is the only thing enforced: for example a share must be above 0% and at most 100%, rates and haircuts cannot be negative, a haircut cannot exceed 100%, and a slider needs its minimum below its maximum. The advisory band is roughly half to one and a half times the default, the region the model was explored over. It is never enforced: outside it, the control shows a plain note, "outside the range this model has been explored over", and the run goes ahead. The bands and limits below are written that way.

A collapsed panel under the scenario detail. Every control takes a typed number as well as a slider, and shows its default, a "changed" marker and its own reset. "Reset all" and a "custom settings" note in the results and the export make it plain when a run is not the default. The four current scenarios are the presets; there are no named severity presets, because that would claim a calibration we do not have.

**Shock controls** (live parameters, no rebuild):

- Which institutions are stressed, and each one's withdrawal rate: hard limit 0 to 100% a day (today's 20% ceiling is our own choice and is widened), advisory 0.5 to 3%. "Market-wide" is a shortcut that fills every row.
- Start: how many days after the fork the run begins (default 0). The fork itself stays at day 5, so the canvas fork time does not change.
- Duration of the run on the institutions: default 8 days, hard limit up to the length of the run.
- The forced-sale haircut: hard limit 0 to 100%, advisory up to 70%.
- Central-bank support: on or off, its size as a fraction of the facility maximum, and its delay.
- Length of the whole simulation: default 60 days, hard limit 120 (a cap on how long a run may take).

**Assumptions** (they rebuild the model through an importer option, and sit under "Assumptions, not calibrated"):

- Reserve target share: any value above 0% and up to 100% of deposits, with a note outside about 5 to 20%. Because each institution's target is the smaller of this share of its deposits and the cash it holds now, raising the share beyond an institution's cash changes nothing for that institution, and the label says so.
- Fire-sale rate.
- Market depth, which sets price impact.
- Interbank flow rate.
- Panic sensitivity.
- Central-bank reserves and facility size.
- The lending network, with four plainly labelled options: **real exposures**; **estimated exposures**; **interbank frozen** (each institution keeps its interbank claims and borrowing at book value, but there is no lending between institutions and no defaults are passed on, so a failed institution's creditors take no loss); and **no interbank exposure** (the interbank balances are removed, and both sides of each balance sheet shrink by the interbank amount, so equity is unchanged). The two "none" variants can give different results and each label says which it is. A "show all four side by side" action runs the same scenario on each.

**Fragility is shown beside every assumption.** Next to each assumption control the window shows, computed and not written by hand, what happens when that assumption is halved and when it is raised by half around the current settings, for the chosen scenario and institution: the change in total damage, and the set of institutions that fail. Where the set changes, the control is flagged as fragile in words, for example "halving this: nobody fails; raising it by half: all 8 fail". This is shown whatever the reason, and where one control moves several things at once (the reserve target moves the fire-sale trigger and the panic scale together) the label says so. It costs about 14 short runs, refreshed when a setting changes. The caveat stays next to it: it is measured around the current settings and ignores interactions.

**Fixed:** the time step (numerics, not an assumption), credit shares (they come from the data), payment capacity (it barely matters), and the balance-sheet identities (they are what the tool guarantees). The write-down rate stays fixed until it is understood (see the checks below).

Beside the institution list, show plain data ratios (cash as a share of deposits, interbank dependence). This is a view of the data, not a likelihood: the model has no idea which bank is likely to be run on.

## Multi-run views

All are window-side loops over ordinary single runs, with progress, cancel, two engines at a time, and a results table that records exactly what was run.

- **Rank every bank.** The same shock on each institution, ranked by total system damage, number of failures and time to first failure. Labelled "if this bank were run on", never "most likely to fail".
- **Find the breaking point.** For a chosen institution and one control (the haircut or the withdrawal rate), scan about 12 points, bisect the first change, and rerun just below and just above it to confirm. Two criteria: the chosen institution fails, or a second institution fails (the cascade threshold). Report "first change found, not proven unique", the resolution and the run length, and draw the failure curve.
- **Sensitivity.** Vary each assumption by ±50% of its default, one at a time, and show damage and failures as a bar chart ranked by effect. The caveat is on the chart: it ranks over ranges we chose, not which assumption is most uncertain, and it ignores interactions.
- **Pin a run and compare.** Keep one run's results on screen and show the next run against it, so the network switch and the support comparison read instantly.

## Where the work lives

Almost all of it stays in the Start add-on, using what Konjugate core already provides.

- **Assumptions and the network choice** are importer options. The importer is pure code that already receives options from the window, so it validates them itself and rejects anything out of range with a message.
- **Shock controls** go through the `supplied` mechanism, which already carries values from the window to the host for named entities as a path of time and value pairs. A constant is a two-point path, a start delay is the time of the first point, and several institutions are several entities, each with its own path. The haircut is global, so the importer labels its entry with an entity such as "Asset market" and the window supplies it like any other. The window checks every value against the declared range before sending, and the host's clamp remains as a backstop.
- **The multi-run views, pinned comparison, presets, reset and markers** are window code.

One small, generic core change is needed: **the run manifest records the importer options and the supplied data.** The window cannot add to `run-manifest.json`, and the host does not record either today, so without this the requirement to record every override cannot be met. It is recording only and changes no behaviour. The manifest gains optional fields, `manifestVersion` stays at 1, and older readers ignore the new fields. Optional supporting changes, if the multi-run views need them: a run can choose not to retain its result files (so a batch of 40 does not keep 40), and concurrent runs share one baseline, guarded so it is never started twice.

Compatibility: the manifest `apiVersion` stays at 1 and no existing field changes meaning. A launcher that needs the new recording declares it in an optional `requires` list, and a host that does not know a requirement refuses to load the add-on with a clear message, rather than ignoring it and silently running with defaults. Start declares the requirement; Markets does not, and does not change.

Host-side validation with declared ranges in the manifest, and rejection in place of clamping, are deferred. They would be useful as a uniform check across add-ons, but they are not needed for this design, and doing them opt-in later avoids any risk to Markets.

### Why not programmable nodes

Konjugate can run Python and C++ provider nodes, and a C++ compiler could be a stated prerequisite: it is not bundled, but Konjugate finds one on the machine or uses a path the user sets. We do not use them for scenario controls, for three reasons that do not depend on the compiler. A scenario baked into a provider gives a separate model, which breaks the fork from a checkpoint that Start's baseline-versus-scenario comparison and the canvas branches rely on. A provider recompiles for every distinct source, so every new control value would compile again, and the ranking, breaking-point and sensitivity views would compile hundreds of times, where live parameters and supplied paths need no rebuild. And C++ node providers run in the engine's own process with no isolation. A provider is the right tool if Start ever needs behaviour equations cannot express; nothing in this design does.

## Checks to make before building

- **The write-down rate.** Doubling or halving it changes nothing on the sample data. Establish whether the channel is inert on this data or broken; fix it if broken. Expose it only if it does something.
- **Concurrent runs.** Confirm the host handles overlapping `runScenario` calls, or make it do so.
- **Supplied paths.** Confirm a path holds its last value after its final point, that a two-point constant behaves as a constant, that a start delay of zero reproduces today's results, and that the haircut works through an entity label.
- **Older hosts.** Confirm an older host ignores unknown manifest keys, which is why the `requires` list is needed.
- **Start delay.** Confirm a delayed start reproduces today's results when the delay is zero and behaves sensibly otherwise.
- **Step-grid validation with floating-point steps.**
- **The reserve target at half its default.** It moves the fire-sale trigger and the panic scale together. Establish what "nobody fails" there is, and say so in the fragility label beside the control.
- **The packaged-app importer worker.** Check it runs from a packaged build.

## Tests

- Out-of-range, non-finite and off-step values are rejected by the add-on's validation, before a run starts, and importer options are rejected by the importer.
- Overrides appear in the run manifest (importer options and supplied data), and the changed-from-default record in the export matches what was run; nothing extra appears when nothing is changed.
- Markets gives the same results and the same manifest fields as before, and a launcher that declares an unknown requirement is refused by the host.
- Default runs are identical to today on all four regression targets, with and without the controls panel opened.
- A ranking equals the separate per-bank runs.
- A breaking-point result is confirmed by rerunning just below and just above it, and a non-monotonic case is reported honestly.
- The network options: real reproduces today; estimated, interbank frozen and no interbank exposure each match their own separate headless run, and the two "none" variants are compared with each other on the sample data and their difference reported.
- Fragility markers match separate runs at half and 1.5 times each assumption, and flag a change in the set of failing institutions.
- Sensitivity matches separate runs of each changed assumption.
- The Markets window and both reference models still pass their tests, and the existing element ids are unchanged.

## Documents

Update the assumptions page, the feedback kit, the investor brief and the deck to describe the controls, the multi-run views and what they showed, and report anything that was not tested.

## Deliberately not built

- Live dragging of controls.
- Monte Carlo over the ranges, which implies distributions we do not have.
- A "probability of a run" number.
- Editing equations or the time step.
- Named severity presets such as mild, moderate or extreme.

## What was built, and what changed on the way

Everything in the plan was built, and each part has a test (see the ReadMe: `npm test`, `npm run test:runs` against the real engine, and `npm run test:interaction`).

**Checks made first.**
- The write-down rate is not inert. The default bundle moves a failed institution's shortfall to its creditors, so total damage cannot change with the rate, but when second-round failures happen does (Holly around day 49 or 47 instead of 47.5). It is exposed as "Speed losses reach creditors".
- A supplied path holds its last value after the final point, and a two-point constant behaves as a constant. But a pulse built as a path differs slightly from today's pulse (8,746 against 8,615 total), so defaults keep today's exact mechanism, which is why the design changed to overrides (below).
- All supplied interventions shared one entity list, so the global haircut could not take its own entity. Overrides key the global entry as `*`.
- Two overlapping runs asking for a baseline started it twice. The host now shares one.
- The reserve target at half its default is a real regime, not a side effect: nobody fails in the severe scenario, because stress then starts far less often.
- Not checked: that an older Konjugate ignores unknown manifest keys (which is why `requires` exists and makes such a host refuse the add-on instead), and that the importer worker runs from a packaged build.

**Core changes, all generic.**
- A scenario run may pass `overrides`, `{ parameter: { entity or '*': { value, at, duration } or null } }`, which adjust the scenario's declared interventions for parameters the importer declared live. With none, nothing changes, so a default run and Markets are untouched by construction (tests: defaults reproduce the four regression targets; restating the defaults as overrides gives the same run).
- The run manifest records the importer options and the overrides, and records nothing extra when there are none (`manifestVersion` stays 1).
- A launcher may list `requires` (`scenarioOverrides`, `runRecord`); a host that does not know one refuses the launcher. Start declares both, Markets declares nothing.
- A run can choose not to retain its result files, runs share one baseline per run length, and the manifest summary of each scenario lists its declared changes.
- Not done, as planned: host-side validation with declared ranges, and rejecting instead of clamping. The window checks every value against its hard limit before sending, and the host's clamp remains as a backstop.

**The add-on.**
- `lib/scenarioControls.mjs` holds every setting once: default, hard limit and advisory band. `lib/scenarioRequest.mjs` turns the controls into a run request (empty at the defaults). `lib/explore.mjs` holds the ranking, breaking-point and sensitivity logic, driven by a `run` function so the tests can drive it with the real engine and with stand-ins.
- The importer takes options: the assumptions (each checked against its hard limit, with a sentence for every problem) and the network treatment.
- The "no interbank exposure" rule, as built: each institution settles its net interbank position (claims less borrowing) in cash, so its equity is unchanged and its balance sheet balances. The plan said both sides of the balance sheet shrink by the interbank amount, which is not enough, because claims and borrowing differ for one institution.
- Hard limits as built: reserve target 0.1% to 100% of deposits, forced-sale speed 0 to 100% of loans a day, market depth 1% to 1,000% of loans, lending speed 0 to 1 a day, panic sensitivity 0 to 50, write-down speed 0.01 to 5, central-bank reserves 0 to 500% of deposits, facility 0.1% to 100% of deposits a day, withdrawal rate 0 to 100% a day, discount 0 to 100%, simulation length 6 to 120 days. Every assumption at both of its limits builds and runs (a test).

**Differences from the plan.**
- The fragility line beside each assumption is computed by a button ("Check how much each assumption matters", or on the Explore step) and not after every change, because it takes about fourteen rebuilt runs. It is marked "out of date" once any setting changes. Everything it says is computed, and the reserve target is flagged in words either way.
- The headline text is unchanged whatever the settings. Custom settings are announced in a separate box under the tiles (`#customSettings`), so the recording script's headline text does not depend on them.
- A fifth step, Explore, sits before Learn, so Learn's number on the rail is now 5. Every existing id and its text are otherwise unchanged (checked by the existing interaction test, which passes as it was).
- Ranking and comparison use two engines at a time.

**Findings from the runs (sample data, Alder Bank stressed, severe scenario, 60 days).**

| Treatment of the interbank network | Who fails | Total equity down |
|---|---|---|
| Exposures as given | Alder day 14, Holly 47.5, Fir 52.5 | 49,339 |
| Estimated from totals | Alder day 14, Holly 55.5 | 56,423 |
| Interbank frozen | Alder day 13.5 | 40,791 |
| No interbank exposure | Alder day 17 | 33,380 |

The two ways of having no network differ, as the reviewer suspected. Ranking, the same shock on each institution: Alder 49,339 (three fail), Dune 42,085, Holly 34,302, Birch 27,408, Fir 14,915, Cedar 11,527, Elm 5,959, Gum 4,400, and in every other case only the institution run on fails. Breaking points, Alder run on at 1.5% a day for 8 days: Alder first fails from a discount of about 18.4% and a second institution from about 47.5%; against the withdrawal rate at a 50% discount, Alder first fails between about 0.5% and 1.1% a day. Sensitivity in the severe scenario: halving the reserve target means nobody fails and damage falls 86%; forced-sale speed −26% and +22% (fewer or more fail); the write-down speed changes nothing in total.
