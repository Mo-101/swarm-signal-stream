# Run v1 as a scored shadow, keep v3 as the live book

## My honest read

Switching the engine back to v1 would be a mistake, and here is why.

v3 is not a rival of v1 — it *is* v1's geometry (wide vol stops 150-450 bps, 2:1 reward, delayed breakeven) with one difference: entries rest passively as maker orders instead of crossing the spread. Measured round-trip execution went from **+34 bps of cost (v1)** to **a credit (v2/v3)**. Same brackets, cheaper fills, is strictly better in expectation. There is no mechanism by which paying 34 bps more per round trip makes v1 win.

What actually made v1's +$620 look good is unproven: 72 trades over one market period, driven by a 2:1 payoff on a 40% win rate. That is a real result, but it is also exactly the shape a favourable regime produces. v3 has 7 closes. Comparing 72 to 7 and declaring v1 the winner is reading noise.

The failed experiment was **v2** — tight brackets — and v3 already reverted that. The correct move is not to roll back further; it is to keep the cheap fills and let the sample grow, while keeping v1 honestly scored so the claim can be settled with evidence instead of preference.

## What to build

Keep v3 as the only book that touches paper equity. Add a **v1 replica shadow book** that takes every signal v3 actually trades and re-runs it under v1 rules — flat 2%/4% brackets, market take-profits, taker entry crossing the spread, no breakeven, no trail, no cost gate — marked against the same live ticks.

That gives a true paired A/B: identical signals, identical ticks, only the ruleset differs. No capital split, no halved position size, and after ~30 shared signals the answer stops being an argument.

```text
 signal ──┬─► v3 broker      (real paper equity, maker entry, wide stops)
          └─► v1 replica     (shadow only, taker entry, flat 2%/4%)
                 └─► paired comparison: same signal, same ticks
```

Add a **Replica** section to the Execution tab showing, side by side over the paired sample: net USD, win rate, expectancy per trade, and round-trip execution cost in bps — plus the paired difference, which is the number that actually decides it.

If the replica beats v3 over 30+ paired closes by more than the execution-cost gap can explain, that is a real signal and I will revert the geometry then, with evidence.

## Technical notes

- Extend `src/lib/shadow-book.ts` with a configurable ruleset so a second instance can run v1 brackets (`slPct 0.02`, `tpPct 0.04`, taker fee on both legs, no trailing) instead of mirroring the live paper config.
- Instantiate the replica in `src/lib/engine-runtime.ts` alongside the existing counterfactual book, fed from accepted proposals rather than rejected ones, marked on the same tick stream.
- Persist replica closes with `strategy_epoch = 'v1-replica'` through the existing store paths in `src/lib/db/supabase-store.server.ts` so the existing epoch filtering keeps learning scoped to v3 and the replica stays audit-only.
- Surface the paired comparison in `src/components/ExecutionPanel.tsx`; no changes to risk limits, sizing, or the live routing path.
- `STRATEGY_EPOCH` stays `"v3"`. Agent weights and confidence calibration continue to learn from v3 only.

## Not doing

- Splitting paper equity into two live books — halves size per book and doubles the time to significance for no analytical gain over a paired shadow.
- Reverting `DEFAULT_PAPER_CONFIG` to v1 geometry now. If the replica earns it, that revert happens with data behind it.
