-- Neon mirror of the Supabase schema (supabase/migrations/*.sql). Neon has
-- no auth.users table and no RLS-via-JWT bridge, so:
--   * user_id is a plain uuid (the Supabase auth user id, passed in from the
--     already-verified session — Supabase stays the source of truth for
--     auth, Neon just stores data scoped to that same id).
--   * there is no FK to auth.users and no RLS policies. Every query in
--     src/lib/db/edge-store.ts filters by user_id explicitly instead.
--   * edge_report() takes user_id as an explicit argument instead of
--     reading auth.uid().
-- Neon-local auth: canonical user records so sign-in works even when the
-- Supabase project is unreachable. When a Supabase login succeeds its user id
-- and credentials are mirrored here automatically with the same id, so all
-- data stays attached. When Supabase is down, sign-in verifies against this table.
CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
ALTER TABLE runner_state ADD COLUMN IF NOT EXISTS shadow jsonb;

-- Counterfactual shadow book. runner_state.shadow holds only the rolled-up
-- ShadowStats for the dashboard; this table is the durable per-trade record,
-- so a restart resumes the book instead of restarting the evidence from zero.
-- gross_bps/fee_usd/funding_usd are stored alongside net_usd because the whole
-- point of the book is proving whether the gate earns its keep — a net number
-- with the costs folded in cannot be audited after the fact.
CREATE TABLE IF NOT EXISTS shadow_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  shadow_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  reason text NOT NULL,
  confidence numeric NOT NULL,
  regime text NOT NULL DEFAULT 'unknown',
  notional numeric NOT NULL,
  entry_price numeric NOT NULL,
  stop_loss numeric NOT NULL,
  take_profit numeric NOT NULL,
  status text NOT NULL DEFAULT 'open',
  last_price numeric NOT NULL,
  last_marked_at timestamptz NOT NULL,
  max_favourable_bps numeric NOT NULL DEFAULT 0,
  max_adverse_bps numeric NOT NULL DEFAULT 0,
  exit_price numeric,
  exit_reason text,
  gross_bps numeric,
  net_bps numeric,
  net_usd numeric,
  fee_usd numeric,
  funding_usd numeric,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  UNIQUE (user_id, shadow_id)
);
CREATE INDEX IF NOT EXISTS shadow_trades_user_status_idx
  ON shadow_trades (user_id, status, closed_at DESC);

-- Futures grid bot state. Its own table rather than another runner_state
-- column: config and runtime state change on a different cadence from the
-- heartbeat, and one row per (user, symbol) lets several grids run without
-- contending on a single row.
CREATE TABLE IF NOT EXISTS futures_grid_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  config jsonb NOT NULL,
  runtime_state jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);
CREATE INDEX IF NOT EXISTS futures_grid_state_user_idx ON futures_grid_state (user_id);
CREATE INDEX IF NOT EXISTS futures_grid_state_active_idx ON futures_grid_state (user_id, active);

-- Live (real-money) trading — kept in its own tables, deliberately separate
-- from paper_accounts/paper_trades: a query bug here can never leak a real
-- position into the paper-simulation view or vice versa. provider is
-- 'binance' | 'bybit' — one account per (user, provider), since each venue
-- has its own wallet/balance.
CREATE TABLE IF NOT EXISTS live_accounts (
  user_id uuid NOT NULL,
  provider text NOT NULL,
  realized_pnl numeric NOT NULL DEFAULT 0,
  halted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS live_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL,
  client_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  entry_price numeric NOT NULL,
  exit_price numeric,
  size numeric NOT NULL,
  notional numeric NOT NULL,
  stop_loss numeric,
  take_profit numeric,
  leverage numeric,
  -- Exit is a trailing stop, not a fixed TP: trailing_active_price is where
  -- the trail arms, trailing_distance is how far price can retrace from its
  -- peak before the exchange closes the position. take_profit above is kept
  -- only as an informational reference, never sent as a hard TP order.
  trailing_active_price numeric,
  trailing_distance numeric,
  status text NOT NULL DEFAULT 'open',
  pnl numeric,
  pnl_pct numeric,
  reason text,
  entry_order_id text,
  sl_order_id text,
  tp_order_id text,
  exit_order_id text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (user_id, provider, client_id)
);
ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS trailing_active_price numeric;
ALTER TABLE live_trades ADD COLUMN IF NOT EXISTS trailing_distance numeric;
CREATE INDEX IF NOT EXISTS live_trades_user_status_idx
  ON live_trades (user_id, provider, status, opened_at DESC);

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
