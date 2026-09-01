# Mathematical Correctness Hardening

Goal: make every number the swarm produces provably correct — one canonical definition per quantity, one unit convention, and automated tests that fail the build if any formula drifts.

## What's wrong today (structural, not strategy)

- **No test suite at all.** No vitest, no golden cases. Every formula (fees, funding, liquidation, PnL, expectancy) is only validated by eyeballing the dashboard.
- **Mixed units.** bps, percent, and raw fractions travel through the same code paths (`slipBps`, `pnlPct`, `takerFeeRate: 0.00055`, `requiredEdgeBps`). Nothing enforces which one a function expects, so a single missing `/10000` silently changes results.
- **Duplicated formulas.** Fees/slippage/funding math exists in `paper-broker.ts`, `shadow-book.ts` and `edge-model.ts` separately. They can (and do) drift apart, so shadow vs. real comparisons aren't apples-to-apples.
- **Ambiguous denominators.** `pnlPct` divides by entry notional while risk/drawdown divides by equity, and liquidation PnL is special-cased. Displayed "return" therefore means different things in different panels.
- **Float money.** Balances, fees and funding accumulate in binary floats with no rounding to instrument tick/qty steps, so long runs drift and sizes can be non-executable on the real venue.
- **Unvalidated statistics.** Win rate, expectancy and edge weights are computed without variance/confidence bounds, so small samples can look like edges.

## The fix, in five layers

### 1. One canonical units module (`src/lib/math/units.ts`)
Branded types `Bps`, `Ratio`, `Price`, `Qty`, `Usd` plus the only allowed converters (`bpsToRatio`, `ratioToBps`, `pct`). Every formula signature is retyped so mixing bps into a ratio slot becomes a compile error, not a silent 100x bug.

### 2. One canonical formula module (`src/lib/math/perp.ts`)
Single source of truth, pure functions, no side effects:
notional, initial margin, maintenance margin by tier, liquidation price (long/short, isolated), taker fee, funding payment, gross PnL, net PnL, ROE vs. ROI (both, explicitly named), slippage vs. reference, VWAP fill from an L2 walk, break-even move required to clear round-trip cost.
`paper-broker.ts`, `shadow-book.ts`, `microstructure.ts` and `edge-model.ts` all delegate here — no local re-implementations remain.

### 3. Exchange-exact rounding (`src/lib/math/rounding.ts`)
Fetch and cache Bybit instrument filters (tickSize, qtyStep, minOrderQty, minNotional). All prices round to tick, all sizes floor to qty step, and money accumulates through integer-cent (or scaled-int) accumulators so realized PnL never drifts. Orders that fail min-notional after rounding are rejected explicitly instead of being simulated at impossible sizes.

### 4. Verification suite (vitest)
- **Golden tests:** hand-computed Bybit examples (fee, funding, liq price, PnL for long and short, cross-checked against Bybit's published worked examples) assert exact expected values.
- **Property tests:** invariants that must hold for random inputs — closing at entry price yields exactly `-(entryFee+exitFee+funding)`; long PnL at price P equals negated short PnL at P; liq price always sits beyond the stop for leverage ≤ tier max; account equity always equals `startingBalance + Σ realized + Σ unrealized`; VWAP fill price is always between best and worst consumed level.
- **Reconciliation test:** replay a recorded tick+book fixture through the engine twice and assert bit-identical results (determinism), and assert the ledger sums to the account balance.
- CI-style script `npm run verify` = typecheck + vitest.

### 5. Statistical validity in the edge layer
Report Wilson confidence intervals on win rate, standard error on expectancy, and t-stat/sample count next to every agent and symbol bucket. Weights only move when the lower CI bound clears zero (in addition to the existing `MIN_BUCKET_SAMPLE`). Panels label each metric with its exact denominator (ROE on margin vs. ROI on notional).

## Also included

- A **self-audit panel** row: live invariant checks (ledger balance, margin sum, unrealized recompute) shown green/red on the System tab so a formula regression is visible immediately.
- Fix the current dashboard 500s: the Bybit status/history polls still fire unauthenticated in guest mode.

## Technical notes

New files: `src/lib/math/{units,perp,rounding,stats}.ts`, `src/lib/math/__tests__/*.test.ts`, `vitest.config.ts`, dev deps `vitest` + `fast-check`. Refactors are delegation-only — no strategy or threshold changes — so behaviour stays identical except where a test proves the old number was wrong; each such correction is listed in the final summary.

## Question before building

Rounding to real Bybit tick/qty steps will change historical comparability: past paper trades were sized without those filters. Options: apply filters to new trades only (default), or reset the paper account for a clean, fully-canonical run.
