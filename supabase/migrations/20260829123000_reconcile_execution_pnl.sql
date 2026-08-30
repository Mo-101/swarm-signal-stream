-- Close the gross/net reconciliation gap in the execution report.
--
-- THE BUG. The execution block summed gross_pnl and pnl over the same rows,
-- but gross_pnl is NULL on every trade written before that column existed.
-- sum() skips NULLs, so those rows contributed their pnl to net_pnl and
-- nothing to gross_pnl. The report therefore showed a FIXED discrepancy —
-- constant across snapshots, because the legacy row set never grows:
--
--   gross 519.06 - fees 94.02 - funding 8.77 = 416.27, reported net 451.61
--   gross 505.33 - fees 97.32 - funding 8.77 = 399.24, reported net 434.58
--                                              gap =  35.34 in both cases
--
-- That gap is the sum of pnl over the NULL-gross_pnl rows. It is not a formula
-- error and it is NOT slippage.
--
-- ON SLIPPAGE. gross_pnl is computed from the prices the engine actually
-- FILLED at, so execution slippage is already inside it. slip_cost_usd
-- measures fill-vs-signal drift for attribution only and must never be
-- subtracted from gross a second time. The identity is:
--
--   net = gross - fees + funding_cashflow        (funding signed as cashflow)
--   net = gross - fees - funding                 (funding stored as paid, as here)
--
-- 1. Backfill the legacy rows. Their pnl was already net and their cost
--    breakdown was never recorded, so gross = pnl with zero recorded costs is
--    the only honest reconstruction. It leaves those rows cost-neutral rather
--    than silently absent from the numerator.
UPDATE public.paper_trades
   SET gross_pnl = coalesce(gross_pnl, pnl),
       fees = coalesce(fees, 0),
       funding = coalesce(funding, 0)
 WHERE status = 'closed' AND pnl IS NOT NULL
   AND (gross_pnl IS NULL OR fees IS NULL OR funding IS NULL);

-- 1b. Legacy rows whose stored pnl OMITTED THE ENTRY FEE.
--
-- Trade-level pnl used to be gross - exitFee - funding, leaving the entry fee
-- out (see the note in paper-broker.closePosition). The entry fee WAS still
-- deducted from the account's realized_pnl at open, so the trade table
-- understated cost relative to the account, and every per-trade statistic —
-- expectancy, win rate, per-agent PnL — was measured against a number too
-- generous by exactly one taker leg.
--
-- Measured on live data: 41 of 70 closed trades were affected, each with a
-- residual equal to its entry fee to the cent, totalling $35.34. Restating pnl
-- to the full net identity is what makes the trade table agree with the
-- account and with every trade closed since the fix.
--
-- Liquidations are excluded: their pnl is deliberately capped at the posted
-- margin rather than derived from the exit fill.
--
-- Idempotent: after one pass the WHERE clause matches nothing.
UPDATE public.paper_trades
   SET pnl = gross_pnl - fees - funding,
       pnl_pct = CASE
                   WHEN entry_price * size > 0
                     THEN ((gross_pnl - fees - funding) / (entry_price * size)) * 100
                   ELSE pnl_pct
                 END
 WHERE status = 'closed'
   AND pnl IS NOT NULL
   AND gross_pnl IS NOT NULL
   AND coalesce(reason, '') <> 'LIQ'
   AND abs(pnl - (gross_pnl - fees - funding)) > 0.01;

-- 2. Report the residual instead of letting it hide. Any future divergence
--    (a liquidation, whose pnl is capped at the margin rather than derived
--    from the exit, or a write path that forgets a column) shows up as a
--    non-zero 'residual' rather than as a quietly wrong headline number.
CREATE OR REPLACE FUNCTION public.edge_report(p_epoch text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH closed AS (
  SELECT * FROM public.paper_trades
  WHERE user_id = auth.uid() AND status = 'closed' AND pnl IS NOT NULL
    AND (p_epoch IS NULL OR strategy_epoch = ANY(string_to_array(p_epoch, ',')))
),
agents AS (
  SELECT a.key AS name,
         count(*)::int AS trades,
         count(*) FILTER (WHERE c.pnl > 0)::int AS wins,
         coalesce(sum(c.pnl), 0)::numeric AS pnl,
         coalesce(avg(c.pnl), 0)::numeric AS expectancy,
         coalesce(avg(c.gross_pnl), 0)::numeric AS gross_expectancy,
         coalesce(avg(c.entry_slip_bps + c.exit_slip_bps), 0)::numeric AS avg_slip_bps
  FROM closed c, jsonb_each(c.agents) a
  WHERE (a.value->>'direction') = c.side
  GROUP BY a.key
),
symbols AS (
  SELECT symbol AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy,
         coalesce(avg(gross_pnl), 0)::numeric AS gross_expectancy,
         coalesce(avg(entry_slip_bps + exit_slip_bps), 0)::numeric AS avg_slip_bps,
         coalesce(avg(spread_entry_bps), 0)::numeric AS avg_spread_bps
  FROM closed GROUP BY symbol
),
regimes AS (
  SELECT regime AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy,
         coalesce(avg(gross_pnl), 0)::numeric AS gross_expectancy,
         coalesce(avg(entry_slip_bps + exit_slip_bps), 0)::numeric AS avg_slip_bps
  FROM closed GROUP BY regime
),
hours AS (
  SELECT hour_utc::text AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy,
         coalesce(avg(gross_pnl), 0)::numeric AS gross_expectancy,
         coalesce(avg(entry_slip_bps + exit_slip_bps), 0)::numeric AS avg_slip_bps
  FROM closed GROUP BY hour_utc
),
confs AS (
  SELECT conf_bucket AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy,
         coalesce(avg(gross_pnl), 0)::numeric AS gross_expectancy,
         coalesce(avg(entry_slip_bps + exit_slip_bps), 0)::numeric AS avg_slip_bps,
         coalesce(avg(confidence), 0)::numeric AS avg_confidence
  FROM closed GROUP BY conf_bucket
)
SELECT jsonb_build_object(
  'totals', (SELECT jsonb_build_object(
      'trades', count(*)::int,
      'wins', count(*) FILTER (WHERE pnl > 0)::int,
      'pnl', coalesce(sum(pnl), 0),
      'expectancy', coalesce(avg(pnl), 0)) FROM closed),
  'execution', (SELECT jsonb_build_object(
      'trades', count(*)::int,
      'gross_pnl', coalesce(sum(gross_pnl), 0),
      'net_pnl', coalesce(sum(pnl), 0),
      'fees', coalesce(sum(fees), 0),
      'funding', coalesce(sum(funding), 0),
      -- Attribution only. Already inside gross_pnl; never a deduction from it.
      'slip_cost', coalesce(sum(slip_cost_usd), 0),
      -- net - (gross - fees - funding). Must be ~0 outside liquidations.
      'residual', coalesce(sum(pnl), 0)
                  - (coalesce(sum(gross_pnl), 0)
                     - coalesce(sum(fees), 0)
                     - coalesce(sum(funding), 0)),
      -- Rows that cannot satisfy the identity, so a non-zero residual can be
      -- explained rather than merely observed.
      'unreconciled', count(*) FILTER (
          WHERE abs(coalesce(pnl, 0)
                    - (coalesce(gross_pnl, 0)
                       - coalesce(fees, 0)
                       - coalesce(funding, 0))) > 0.01)::int,
      'avg_entry_slip_bps', coalesce(avg(entry_slip_bps), 0),
      'avg_exit_slip_bps', coalesce(avg(exit_slip_bps), 0),
      'avg_spread_bps', coalesce(avg(spread_entry_bps), 0),
      'avg_latency_ms', coalesce(avg(latency_ms), 0),
      'book_priced', count(*) FILTER (WHERE book_priced)::int,
      'liquidations', count(*) FILTER (WHERE reason = 'LIQ')::int) FROM closed),
  'agents', coalesce((SELECT jsonb_agg(to_jsonb(agents)) FROM agents), '[]'::jsonb),
  'symbols', coalesce((SELECT jsonb_agg(to_jsonb(symbols)) FROM symbols), '[]'::jsonb),
  'regimes', coalesce((SELECT jsonb_agg(to_jsonb(regimes)) FROM regimes), '[]'::jsonb),
  'hours', coalesce((SELECT jsonb_agg(to_jsonb(hours)) FROM hours), '[]'::jsonb),
  'confidence', coalesce((SELECT jsonb_agg(to_jsonb(confs)) FROM confs), '[]'::jsonb)
);
$function$;
