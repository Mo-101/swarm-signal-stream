# Builder brief: get one alpha-swarm hypothesis proven

**Branch:** `court/signal-court` · **Owner:** MoStar Intelligent Systems · **Date:** 2026-09-28

Read this top to bottom and build in the order given. Step 2 depends on step 1's answer; do not start step 3 before step 2's verdict is in.

---

## 1. Where the evidence stands (Signal Court, live data, 28 Sep 2026)

All figures are bps of entry notional per trade, net of fees and funding unless marked gross. "Episodes" are 6-hour market blocks; they are the real sample size, because positions opened into the same move are one bet.

| Hypothesis | Trades | Episodes | Gross | Costs | Net | Verdict |
|---|---|---|---|---|---|---|
| `shadow:all` (every refused proposal, 2h time exit) | 194,832 | 132 | −1.5 | 11 | −12.5 | NOT PROVEN: loses before costs |
| `signals:all` (swarm signals, candle replay, 48h time exit) | 203,307 | 55 | **+7.1** | 15 | −7.9 | NOT PROVEN: costs eat the gross |
| `signals:conf:0.60-0.70` | 166,914 | 55 | +6.6 | 15 | −8.4 | NOT PROVEN |
| `signals:conf:0.70-0.80` | 34,571 | 55 | +9.1 | 15 | −5.9 | NOT PROVEN |
| `signals:conf:>=0.80` | 1,822 | 54 | **+14.4** | 15 | **−0.6** | NOT PROVEN (holdout passes) |
| `epoch:v1` (paper) | 45 | 12 | +96.3 | 12 | +84.3 | NOT PROVEN: direction test fails, 95% range crosses zero |
| `sigmalui:all` | 102 | 2 | +17.3 | 15 | +2.3 | NOT PROVEN: 2 episodes, far too early |

What this says, in order of confidence:

1. **The shadow configuration has no edge.** −1.5 bps gross over 194k trades with a tight range. Do not spend any more build time on the confidence gate, suppression, or the 2h time exit as they stand.
2. **Swarm signals are positive before costs, and gross rises with confidence** (6.6 → 9.1 → 14.4 bps). The ≥0.80 bucket is 0.6 bps from breaking even.
3. **Costs are the wall.** Current round trip = 5.5 bps taker + 2 bps slippage on each leg = 15 bps. The gross edge is smaller than that at every confidence level.
4. **Direction is unproven.** Every hypothesis fails the direction charge: the mirrored trade (same entry, opposite side, same brackets) did about as well. Part of the gross may come from the 2%/4% bracket shape in a volatile market, not from the swarm's calls.
5. **Horizon may matter.** The same proposals lose before costs with a 2h exit (shadow book) and make +7.1 gross with a 48h exit (replay). Not proven; a hypothesis to test, not a fact.

Everything below is aimed at points 3, 4 and 5, using data that already exists. **None of it requires live trading or waiting for new trades.**

---

## 2. Rules the builder must not break

- **Signal first, strategy second.** No leverage, sizing, or live-execution work on any hypothesis the court has not convicted.
- **Register before you look.** Every new variant is added to the docket as a named hypothesis (id + claim) *before* its results are computed. Every variant counts as a trial; the deflation charge will raise the bar for all of them. Never add a variant because an earlier one looked close.
- **Do not change `DEFAULT_RULES`** in `src/lib/court/court.ts`. The registry digest binds verdicts to those rules; changing them makes the court refuse to write (by design).
- **Trading stays halted.** `halt-trading.mjs --resume` is gated on a CONVICTED verdict. Do not use `--override-court`.
- **Everything is a replay against existing data** (signals table + cached Bybit candles). Reuse `src/lib/court/replay.ts` and `replay-run.server.ts`; do not write a second replay engine.

---

## 3. Build order

### Step 1: Maker-entry cost replay (answers point 3)

**Question:** if entries rest as post-only limits instead of crossing the spread, does the ≥0.80 bucket clear its costs after the fills we would *not* have got?

Build a maker variant of the replay in `src/lib/court/replay.ts`:

- Entry: post-only limit at the signal price. It fills only if a later 1m candle trades **through** the limit (`low < limit` for BUY, `high > limit` for SELL) within **5 minutes**. Unfilled signals are recorded as `unfilled` and excluded from the trade set; report the fill rate.
- Brackets measured from the fill price, same 2% / 4% and same 48h time exit.
- Costs (Bybit linear): maker 2.0 bps on entry; TP exit as a resting limit at maker 2.0 bps; SL and time exits cross at taker 5.5 bps + 2 bps slippage. No slippage on maker legs.
- Mirror (direction placebo): the mirrored trade must go through the same fill rule from its own side.

Register these hypotheses (ids exactly as written), judged together in one docket:

- `signals:maker:all`
- `signals:maker:conf:>=0.80`
- `signals:maker:conf:0.70-0.80`

Why: at a 36% win rate the expected cost falls from 15 bps to about 7.5 bps (0.36 × 4 + 0.64 × 9.5). The ≥0.80 bucket's +14.4 gross would then clear by roughly 7 bps, **before** adverse selection. Maker fills are adversely selected (you get filled when price moves against you), which is exactly what the through-the-limit rule measures. The replay tells us whether any of that survives.

**Done when:** the three verdicts are in `court_verdicts` and visible in the Court tab, with fill rate reported beside each.

### Step 2: Direction-free control (answers point 4)

**Question:** is the swarm's direction worth anything, or is the gross coming from the brackets and the market's volatility?

For every replayed signal, also replay a **coin-flip twin**: same time, same symbol, same fill rule and brackets, direction chosen by a seeded RNG (`mulberry32`, seed fixed in code). Register:

- `control:random-direction` (all twins)
- `control:random-direction:conf:>=0.80` (twins of the ≥0.80 signals)

Read the result against step 1:

- If `signals:maker:conf:>=0.80` is convicted and `control:random-direction:conf:>=0.80` is not, **direction adds value**: continue to step 3.
- If both look alike, **the swarm's direction is not the edge.** Then the edge (if any) is *when* to trade, not *which way*. Stop tuning the agents, and step 3 becomes a volatility-timing question instead.

**Done when:** both control verdicts sit beside the step-1 verdicts in the Court tab.

### Step 3: Horizon and bracket geometry (answers point 5). Only after steps 1 and 2.

A small, fixed family. Register all of them before running any; the deflation charge will count all of them:

| id | Stop | Target | Time exit |
|---|---|---|---|
| `geom:2-4-48h` | 2% | 4% | 48h (current) |
| `geom:2-4-12h` | 2% | 4% | 12h |
| `geom:3-6-48h` | 3% | 6% | 48h |
| `geom:4-8-96h` | 4% | 8% | 96h |

Run each under whichever entry mode step 1 found cheaper, on the conf bucket step 2 kept. No other variants. Costs are fixed per trade, so wider brackets shrink costs relative to the move; that is the hypothesis being tested, not a promise.

---

## 4. What "proven" means (unchanged)

A hypothesis is CONVICTED only when it answers all eight charges in `src/lib/court/court.ts`:

evidence · profitable (net 95% lower bound > 0) · direction (beats its mirror) · deflation (DSR ≥ 0.95 across the docket) · holdout (last 40%) · stability (≥ 4 of 5 folds) · breadth (survives dropping the best 5%) · gate (profit factor ≥ 1.30).

After conviction it goes on parole: the decay watch retires it automatically if the edge fades, and a retired hypothesis restarts its evidence from zero.

---

## 5. Engineering tasks alongside (no court dependency)

1. **Merge `court/signal-court` to `main`.** Production pulls images built from `main` (Watchtower). Until merge, the VPS dashboard does not have the Court tab, the signal board, or the 6-hourly sessions. Apply `src/lib/db/schema.sql` on deploy (the deploy script already does).
2. **Leverage sizing on the Signal board**, shown only for SURFACED signals: size from `RISK_PER_TRADE` (0.5% of equity) and SL distance; isolated margin at `LEVERAGE` (5×); reject any setting whose liquidation price falls inside the SL, using `RISK_LIMIT_TIERS` in `src/lib/paper-broker.ts`. Leverage scales P&L and risk; it never changes a verdict.
3. **SigmaLui:** leave it recording. 102 signals in 2 episodes is too little; revisit when the Court tab shows ≥ 30 episodes.

---

## 6. File map

| What | Where |
|---|---|
| Court rules, docket, judge | `src/lib/court/court.ts` |
| Replay engine (fills, brackets, mirror) | `src/lib/court/replay.ts` |
| Replay runner + candle source | `src/lib/court/replay-run.server.ts`, `candles.server.ts` |
| Signal events + signal docket | `src/lib/court/signals.ts` |
| Loaders, verdict store, history | `src/lib/court/store.server.ts` |
| 6-hourly session (runner) | `src/lib/court/snapshot.server.ts`, wired in `runner/index.ts` |
| Parole / decay watch | `src/lib/court/parole.ts`, `decay.ts` |
| Signal board | `src/lib/court/board.ts`, `src/components/SignalBoard.tsx` |
| Court tab | `src/components/CourtPanel.tsx` |
| Scripts | `scripts/court.ts`, `scripts/signals-replay.ts`, `scripts/sigmalui-replay.ts` |
| Tests (run all: `npx vitest run`) | `src/lib/court/__tests__/` (real-SQL suite: `npm i --no-save @electric-sql/pglite` first) |
