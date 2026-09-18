# DeFi liquidation cascade

## Overview

A thin ETH and USDC liquidity pool is kept near an outside reference price by an arbitrageur. Three lending vaults of increasing leverage read their collateral price from the pool itself, and a liquidator repays unhealthy vaults' debt, seizes their ETH at a discount, and sells it back into the pool. The parameters are illustrative.

## What it shows

Pricing collateral from a thin pool is a real failure mode: a price shock liquidates the riskiest vault, its collateral sale pushes the pool below the outside price, and the lower price makes a second vault liquidatable although the outside price never reached its limit. ETH is conserved across the pool, arbitrageur, liquidator and vaults, and USDC held minus outstanding debt is conserved, because repaid debt leaves both.

## What to try

1. Run it for 30 days at the default reference price of 2,000. Nothing happens: the pool sits at the outside price and the vaults are untouched.
2. Scrub to day 5 and choose Fork here. Set the shared parameter Reference price to 1,600 (a 20% fall) and run to day 30.
3. Compare the branches. Vault 3 is fully liquidated and is left with bad debt, vault 2 is partly liquidated by the cascade, and vault 1 survives.
4. Try a milder shock (1,800) and a harsher one, and try a ramp instead of a step, using the schedule options in the fork panel.

## Assumptions and limits

- The pool trades along its constant-product curve at a continuous rate rather than in discrete swaps, and there is a single liquidator.
- There are no interest rates, and the pool is deliberately thin relative to the vaults' collateral: that thinness is what makes the feedback visible.
- This is a synthetic model for exploring the mechanism, not a forecast, and it has not been validated against real protocol data.
