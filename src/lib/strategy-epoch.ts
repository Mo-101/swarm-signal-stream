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
 */
export const STRATEGY_EPOCH = "v2";
