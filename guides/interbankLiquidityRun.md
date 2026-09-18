# Interbank liquidity run

## Overview

Three banks share reserves through interbank lending. Depositors run on bank A, banks short of reserves fire-sell loans into a shared market, and a bank whose equity turns negative writes its debt down onto its creditors. A central bank can lend to bank A. The parameters are illustrative, not calibrated to any real institution.

## What it shows

Money and balance sheets are conserved by construction: every flow is a matched pair of edges, so each bank always satisfies reserves + loans + interbank claims = deposits + equity + interbank borrowing. Two channels spread the stress from bank A to the others. Interbank lending moves reserves (and the matching claim and borrowing) between banks. Fire sales push the shared market price down, which worsens every seller's proceeds and losses.

## What to try

1. Run it for 60 days. Bank A becomes insolvent around day 50, and banks B and C lose a large part of their equity as bank A's shortfall reaches them.
2. Scrub the timeline to day 12 and choose Fork here. Raise the shared parameter Emergency lending to 15 and run to day 60: bank A stays solvent and the others are largely spared.
3. Fork the baseline again at day 12 and raise Base haircut from 0.10 to 0.25. The creditors are pushed into insolvency as well.
4. Open the Parameters table to see every constant, what uses it, and edit one in place.

## Assumptions and limits

- Interbank default passes losses to creditors in fixed shares, an even split of each bank's debt between the other two. It does not solve for a clearing vector.
- Interbank loans have no maturities or repayment, and negative equity is not floored, so the size of the losses in the shock fork is illustrative.
- This is a synthetic model for exploring the mechanism. It is not a forecast and has not been validated against real data or reviewed by a practitioner.
