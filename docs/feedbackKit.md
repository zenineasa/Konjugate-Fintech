# Practitioner feedback kit

For the person running the conversation. The goal is not to sell: it is to learn whether the Start window's data format, scenarios and numbers match how a risk or treasury team actually works, and what would stop them using it.

## Before the call

- Install the Konjugate build with the Fintech engine plugin and Start add-on, and open Fintech Start once to confirm it works.
- Have `demo/institutions.csv` and `demo/exposures.csv` ready, and `demo/institutions-with-problems.csv` for the error moment.
- Ask the guest, ahead of time, to bring one real (or anonymised) balance-sheet extract if they are willing. Assume they will not be, and do not press.
- Make clear this is a prototype on synthetic data and that the numbers are stylised, not calibrated to any real institution.

## Ten-minute walkthrough

1. **Frame it (1 min).** "This is a stress-testing sketch: you give it balance sheets, pick a shock, and it shows who fails and when, against a baseline with no shock." Say what it is not: not a regulatory model, not a forecast.
2. **Bring data in (2 min).** Choose the two demo files. Point out the summary ("8 institutions, 38 exposures") and the table. Then choose the problems file and show the error naming the file, line and row. Ask: is this how your data looks, and would you expect a different error?
3. **Pick a scenario (2 min).** Show the four (each has settings behind it; see the third walkthrough): one institution's depositor run, the same run with a severe fire-sale price shock (forced sales at half of book value, where stress spreads to two more banks), that run with central-bank support (compare the last two to see what support is worth), and a market-wide run. Change the institution or severity.
4. **Read the result (3 min).** Read the headline aloud, then the chart of equity against the baseline, then the table. Ask the guest to say, in their words, what they think the number means before you explain it.
5. **Go deeper (1 min).** Open in the canvas to show the baseline and the shock as two branches of the same run, then export and show the run manifest (versions, file hashes, changes applied).
6. **Stop and ask (1 min onward).** Move to the questions; do not keep demoing.

## Optional third walkthrough: settings and exploring (five minutes)

Use this with a guest who wants to challenge the numbers. Nothing here is calibrated, and the point is to show them how much each assumption matters, not to defend a result.

1. **Change one thing (1 minute).** On the scenario page open "Settings for this run" and lower the forced-sale discount from 50% to 30%. Point at the "changed from 50%" marker and run it: one bank fails instead of three. Ask what discount they would consider severe.
2. **Show what drives it (2 minutes).** On the Explore step, "Which assumptions matter": the reserve target is marked fragile, because halving it means nobody fails. Ask which of these assumptions they could actually supply from their own data.
3. **Show the network (1 minute).** "Compare the networks": the same scenario with the exposures as given, estimated, frozen and removed. Ask whether they would have a real exposure matrix.
4. **Rank and break (1 minute).** "Rank institutions" and "Find the breaking point". Say plainly that ranking is "if this bank were run on", and that the breaking point is the first change found, not proven unique.

Questions for this segment:
- Which of these settings would you want to fix from your own data, and which would you leave to us?
- Is a result that flips when one uncalibrated assumption is halved useful to you, or does it make you distrust the tool?
- Would you expect a range or a distribution over the assumptions, rather than one run at a time?
- Which institution would you rank first, and would you trust the ranking?
- What would you need recorded for a result to be reproducible in a review (the run manifest records the options and the changes)?

## Optional second walkthrough: markets (five minutes)

Use this with a guest who watches markets more than balance sheets, or after the first walkthrough if there is time. It needs a network connection only if you fetch live data; the sample series work offline.

1. **Frame it (30 seconds).** "Give it price series, and it looks for which ones move together or lead each other, checks whether that holds up across separate stretches of history, and lets you shock one to see what follows."
2. **Series (1 minute).** Press Use the sample series (made up, with three links planted on purpose). If the guest is willing, fetch three or four tickers they care about instead.
3. **Links (2 minutes).** Point at the two tables. Say plainly what to expect on real daily data: almost no lead-lag links, steady same-bar co-movement. Ask the guest which they would have guessed.
4. **What if (1 minute).** Shock one series and read the headline. Ask what number they expected.
5. **Stop and ask.**

Questions for this segment:
- Which series would you put in? Would you want intraday bars, and from where?
- The window says "nothing reliable" for lead-lag on daily data. Is that useful to you, or would you rather it always showed something?
- Same-bar co-movement cannot say which series drives which. Is a beta-style what-if enough, or would you need something more causal?
- What would make you trust a link: how often it appears across stretches, a comparison with your own model, a longer history?
- Which market data source would your firm allow, and would fetching from the internet be permitted at all?
- Would you use it live, refreshed every few minutes, or only on demand?

## Questions

Ask them open, one at a time, and write down their exact words.

**Data**
- Is a balance sheet per institution plus a bilateral exposure list the right input? What would you actually have?
- What columns are missing? What would you have to compute or clean before you could load it?
- Which delimiter, number format and encoding do your exports use? Where do they come from?
- If you had no exposure matrix, would estimated exposures be acceptable, or would that make the result useless to you?

**Scenarios**
- Which of these four would you run first? Which would you never run?
- What is the scenario you are actually worried about that is not here?
- Would you rather choose shocks or describe an outcome ("what breaks us at 30% haircut")?

**Trust**
- What would make you trust a number like "Alder fails around day 14, and two more later" (in the severe price-shock scenario)? Calibration to your data, a comparison against a model you already use, or something else?
- What would you need to see in the assumptions page before you would show a result to a colleague?
- Is a run manifest with hashes useful to you, or is it noise?

**Adoption**
- Who would use this: you, a quant team, a risk committee? Who decides whether it can be installed?
- What would security or model-risk review block? Local-only execution and no network: does that settle it?
- What do you use today, and what does it cost you in time to answer this question?
- What would have to be true for you to try it on real data next month?

**Close**
- What is the single thing you would change first?
- Who else should we talk to?

## Signals to note

- Which step they reach for the mouse to correct, or go quiet on.
- Numbers they push back on (magnitudes, timing) rather than the interface.
- Any term they use that the tool does not (for example LCR, NSFR, haircuts by asset class).
- Whether they ask for their own data unprompted. That is the strongest signal.

## After the call

Record in one page: who they are, what they use today, the three things that surprised you, answers verbatim to "what would make you trust it" and "what would block it", and whether they will share data or introduce someone.
