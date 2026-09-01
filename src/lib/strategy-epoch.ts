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
 * v1r — v3 stopped. v1's rules are what is RUNNING again: flat 2%/4%
 *      brackets, market take-profits, taker entries, no breakeven/trailing
 *      ratchet, no time/carry exit, no correlation cap or post-stop cooldown,
 *      no symbol cost gate. It is labelled "v1r" rather than "v1" for one
 *      reason only: confidence is on the post-v2 normalized 0.5–1.0 scale,
 *      so v1's stored confidence buckets are not on the same axis and must
 *      not silently calibrate the live threshold. Everything else is v1.
 */
export const STRATEGY_EPOCH = "v1r";

/**
 * RETIREMENT AND EVIDENCE ARE TWO DIFFERENT AXES.
 *
 * An epoch can be retired as a STRATEGY while its trades remain perfectly good
 * EVIDENCE. Conflating the two throws away data for no reason, which is exactly
 * what happened when v3 was retired: the agent pool collapsed from 119 trades
 * to 45 and three of the four agents locked at their base weights, unable ever
 * to unlock — v1 produces no new trades, so that pool could never grow again.
 *
 *   RETIRED_EPOCHS  — do not RUN these rules. A judgement about the strategy.
 *   LEARNING_EPOCHS — trades that may teach agent / symbol / regime weights.
 *                     A judgement about the data.
 *
 * The two overlap deliberately: v3 is retired but still teaches.
 *
 * What genuinely could NOT be pooled was confidence: the scale changed at v2
 * (normalized to 0.5–1.0 by total agent weight, where v1 saturated on |net|),
 * so v1 occupies 0.7–1.0 and v3 occupies 0.6–0.8 with almost no overlap.
 * deriveEdge therefore calibrates minConfidence from confidence_by_epoch scoped
 * to STRATEGY_EPOCH alone, and never from this pooled set. Agent attribution
 * has no such problem — "did Trend point the same way as this trade, and did it
 * win" is scale-free and epoch-free.
 *
 * v2 stays out on evidence grounds, not merely retirement: its expectancy CI
 * sat entirely below zero (n=43, −$7.82/trade, 25.6% win), so it is
 * proven-negative data whose agent attribution reflects rules that were
 * actively losing.
 */
export const LEARNING_EPOCHS = ["v1", "v3"] as const;

/**
 * Epochs that must not be RUN. Note these may still appear in
 * LEARNING_EPOCHS — see the note above; retirement is not a data judgement.
 *
 * v2 — expectancy CI sat entirely below zero (n=43, −$7.82/trade, 25.6% win).
 *
 * v3 — RETIRED: structural cost-floor failure, not a tuning problem.
 *      Measured over 45 closed trades with the accounting identity closing to
 *      $0.00 (signal gross + execution effect = fill gross − fees − funding =
 *      net):
 *
 *        signal edge                            4.03 bps of entry notional
 *        realistic round-trip fee floor         7.50 bps (maker entry + taker exit)
 *        margin                                −3.47 bps
 *        floor if BOTH legs posted as maker     4.00 bps → margin +0.03 bps
 *
 *      The signal does not clear its own transaction-cost floor even before
 *      execution slippage, and the theoretical best case is exactly zero —
 *      stops and liquidations must cross, so both-legs-maker is unattainable.
 *      Maximum available fee saving (~2.5 bps, from driving entries to 100%
 *      maker) is smaller than the 3.47 bps deficit. No parameter change can
 *      close a gap of that shape, so further optimization is not justified.
 *
 *      For contrast, v1 cleared the same floor by 89.27 bps.
 */
export const RETIRED_EPOCHS = ["v2", "v3"] as const;

/** Comma-separated filter understood by the edge_report SQL function. */
export const EDGE_EPOCH_FILTER = LEARNING_EPOCHS.join(",");
