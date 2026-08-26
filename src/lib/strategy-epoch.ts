/**
 * Strategy epoch.
 *
 * Every closed paper trade is stamped with the generation of the strategy that
 * produced it. Learning (agent weights, confidence calibration, symbol
 * suppression) is scoped to the CURRENT epoch so a behavioural change does not
 * get graded on evidence produced by different rules — while the full trade
 * history stays in the database for audit and comparison.
 *
 * Bump this whenever entry sizing, brackets, exits or the confidence scale
 * change in a way that makes older trades non-comparable.
 *
 * v1 — flat 2%/4% brackets, market take-profits, saturated confidence (|net|).
 * v2 — vol-scaled brackets at fixed reward:risk, maker take-profits, breakeven
 *      + trailing stops, time/carry exits, correlation cap, post-stop cooldown,
 *      and confidence normalized to 0.5–1.0 by total agent weight.
 * v3 — passive entry and cost gating kept verbatim from v2, but bracket
 *      geometry reverted toward v1: wider ATR stop multiple (3.5x, 150-450bps)
 *      and the breakeven ratchet delayed to +1.5R with trailing from +2.5R.
 */
export const STRATEGY_EPOCH = "v3";

/**
 * Epochs whose closed trades are allowed to teach the edge model.
 *
 * v2 is retired: its expectancy CI sat entirely below zero (n=43, −$7.82/trade,
 * 25.6% win rate), so it is proven-negative evidence produced by rules we no
 * longer run. v1 and v3 both show positive (if not yet proven) expectancy and
 * comparable bracket geometry, so they are pooled for learning while new trades
 * continue to be stamped with STRATEGY_EPOCH.
 */
export const LEARNING_EPOCHS = ["v1", "v3"] as const;

/** Epochs excluded from learning and from the live scoreboard. */
export const RETIRED_EPOCHS = ["v2"] as const;

/** Comma-separated filter understood by the edge_report SQL function. */
export const EDGE_EPOCH_FILTER = LEARNING_EPOCHS.join(",");
