-- Neon mirror of the Supabase schema (supabase/migrations/*.sql). Neon has
-- no auth.users table and no RLS-via-JWT bridge, so:
--   * user_id is a plain uuid (the Supabase auth user id, passed in from the
--     already-verified session — Supabase stays the source of truth for
--     auth, Neon just stores data scoped to that same id).
--   * there is no FK to auth.users and no RLS policies. Every query in
--     src/lib/db/edge-store.ts filters by user_id explicitly instead.
--   * edge_report() takes user_id as an explicit argument instead of
--     reading auth.uid().
CREATE TABLE IF NOT EXISTS paper_accounts (
  user_id uuid PRIMARY KEY,
  starting_balance numeric NOT NULL DEFAULT 10000,
  realized_pnl numeric NOT NULL DEFAULT 0,
  halted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  entry_price numeric NOT NULL,
  exit_price numeric,
  size numeric NOT NULL,
  notional numeric NOT NULL,
  stop_loss numeric NOT NULL,
  take_profit numeric NOT NULL,
  confidence numeric NOT NULL,
  conf_bucket text NOT NULL,
  agents jsonb NOT NULL DEFAULT '{}'::jsonb,
  regime text NOT NULL DEFAULT 'unknown',
  hour_utc smallint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  pnl numeric,
  pnl_pct numeric,
  reason text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  signal_price numeric,
  entry_slip_bps numeric,
  exit_slip_bps numeric,
  trigger_price numeric,
  spread_entry_bps numeric,
  spread_exit_bps numeric,
  latency_ms numeric,
  slip_cost_usd numeric,
  gross_pnl numeric,
  fees numeric,
  funding numeric,
  leverage numeric,
  liq_price numeric,
  book_priced boolean,
  UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS paper_trades_user_status_idx ON paper_trades (user_id, status, opened_at DESC);

CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  price numeric NOT NULL,
  confidence numeric NOT NULL,
  conf_bucket text NOT NULL,
  agents jsonb NOT NULL DEFAULT '{}'::jsonb,
  regime text NOT NULL DEFAULT 'unknown',
  hour_utc smallint NOT NULL DEFAULT 0,
  executed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_user_created_idx ON signals (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runner_state (
  user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'starting',
  equity numeric NOT NULL DEFAULT 0,
  closed_trades integer NOT NULL DEFAULT 0,
  ticks_per_sec numeric NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION edge_report(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH closed AS (
  SELECT * FROM paper_trades
  WHERE user_id = p_user_id AND status = 'closed' AND pnl IS NOT NULL
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
$$;
