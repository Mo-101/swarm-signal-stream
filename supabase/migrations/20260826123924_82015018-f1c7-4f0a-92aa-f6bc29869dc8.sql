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
      'slip_cost', coalesce(sum(slip_cost_usd), 0),
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