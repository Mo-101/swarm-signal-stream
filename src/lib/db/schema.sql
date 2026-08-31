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
  strategy_epoch text NOT NULL DEFAULT 'v1',
  UNIQUE (user_id, client_id)
);
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS strategy_epoch text NOT NULL DEFAULT 'v1';

-- Liquidity flags per leg. Without these the maker/taker split can only be
-- INFERRED from the blended rate (fees / total notional), which is what forced
-- an inference when v3's cost floor was being measured. A strategy is promoted
-- or retired on whether its signal edge clears its fee floor, so the fee floor
-- must be measured, not reconstructed.
--   maker_entry: entry rested as a post-only limit and earned the maker rate.
--   maker_exit:  exit rested as a reduce-only limit (TP); stops and
--                liquidations must cross and are always taker.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS maker_entry boolean;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS maker_exit boolean;
CREATE INDEX IF NOT EXISTS paper_trades_user_status_idx ON paper_trades (user_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS paper_trades_epoch_idx ON paper_trades (user_id, strategy_epoch, status);

-- Reconcile legacy closed trades to the net identity: net = gross - fees - funding.
--
-- gross_pnl, fees and funding were added after trading had already started, so
-- rows written before that are NULL in those columns. sum() skips NULLs, so
-- those rows contributed their pnl to net_pnl and NOTHING to gross_pnl — the
-- execution report showed a fixed, unexplained gap (gross - fees - funding
-- undershooting reported net by a constant, because the legacy row set never
-- grows). Their pnl was already net and their cost breakdown was never
-- recorded, so gross = pnl with zero recorded costs is the only honest
-- reconstruction: cost-neutral rather than silently missing from the numerator.
-- Idempotent — after the first apply no rows match.
-- Step 1: any row missing a cost column at all.
UPDATE paper_trades
   SET gross_pnl = coalesce(gross_pnl, pnl),
       fees = coalesce(fees, 0),
       funding = coalesce(funding, 0)
 WHERE status = 'closed' AND pnl IS NOT NULL
   AND (gross_pnl IS NULL OR fees IS NULL OR funding IS NULL);

-- Step 2: legacy rows whose stored pnl OMITTED THE ENTRY FEE.
--
-- Trade-level pnl used to be computed as gross - exitFee - funding, leaving
-- the entry fee out (see the note in paper-broker.closePosition). The entry
-- fee was still deducted from the account's realized_pnl at open, so the trade
-- table understated cost relative to the account, and every per-trade edge
-- statistic - expectancy, win rate, per-agent PnL - was measured against a
-- number that was too generous by exactly one taker leg.
--
-- Verified against live data: all 41 offending rows have a residual equal to
-- their entry fee to the cent. Restating pnl to the full net identity is what
-- makes the trade table agree with the account, and with every trade closed
-- since the fix.
--
-- Liquidations are excluded: their pnl is deliberately capped at the posted
-- margin rather than derived from the exit fill, so the identity does not
-- apply to them.
--
-- Idempotent: after one pass the WHERE clause matches nothing.
UPDATE paper_trades
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

-- One row per funding settlement charged to a paper position.
--
-- The UNIQUE constraint is the durable half of the engine's idempotency: the
-- broker keeps an in-memory set of settled boundaries, and this constraint
-- makes that survive a restart. A replayed or double-delivered settlement hits
-- ON CONFLICT DO NOTHING and cannot reach the ledger twice.
--
-- funding_time is the EXCHANGE's settlement timestamp (Bybit nextFundingTime /
-- fundingRateTimestamp), never a locally computed 8h grid point — the schedule
-- is per-symbol and Bybit can change it.
CREATE TABLE IF NOT EXISTS paper_funding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  funding_time timestamptz NOT NULL,
  -- Position quantity AT settlement, not averaged over the interval.
  position_qty numeric NOT NULL,
  mark_price numeric NOT NULL,
  funding_rate numeric NOT NULL,
  interval_ms bigint NOT NULL,
  notional numeric NOT NULL,
  -- Signed as the ledger sees it: positive = the position PAID.
  amount_usd numeric NOT NULL,
  -- 'settled' (confirmed vs history-fund-rate), 'live' (provisional predicted
  -- rate) or 'default' (no exchange rate was available).
  rate_source text NOT NULL DEFAULT 'live',
  strategy_epoch text NOT NULL DEFAULT 'v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, side, funding_time)
);
CREATE INDEX IF NOT EXISTS paper_funding_events_user_time_idx
  ON paper_funding_events (user_id, funding_time DESC);
CREATE INDEX IF NOT EXISTS paper_funding_events_provisional_idx
  ON paper_funding_events (user_id, rate_source) WHERE rate_source <> 'settled';

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
-- Control plane: desired_state is what the user asked for, runtime_status is
-- what the runner is doing. config_version > applied_version means the runner
-- has unapplied work, which is what makes its reconcile loop idempotent.
CREATE TABLE IF NOT EXISTS futures_grid_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  desired_state text NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('stopped', 'running')),
  runtime_status text NOT NULL DEFAULT 'idle'
    CHECK (runtime_status IN ('idle','starting','running','halted','stopping','error')),
  config jsonb NOT NULL,
  runtime_state jsonb,
  config_version bigint NOT NULL DEFAULT 1,
  applied_version bigint NOT NULL DEFAULT 0,
  claimed_by text,
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);
CREATE INDEX IF NOT EXISTS futures_grid_state_user_idx ON futures_grid_state (user_id);
CREATE INDEX IF NOT EXISTS futures_grid_state_desired_idx ON futures_grid_state (desired_state);
CREATE INDEX IF NOT EXISTS futures_grid_state_runtime_idx ON futures_grid_state (runtime_status);

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

CREATE OR REPLACE FUNCTION edge_report(p_user_id uuid, p_epoch text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH closed AS (
  SELECT * FROM paper_trades
  WHERE user_id = p_user_id AND status = 'closed' AND pnl IS NOT NULL
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
),
-- Confidence buckets split BY EPOCH.
--
-- `confs` above pools every learning epoch, which is correct for display but
-- wrong for calibrating an entry threshold: the confidence scale itself
-- changed at v2 (normalized to 0.5-1.0 by total agent weight, where v1
-- saturated on |net|). Pooled, the table describes two different scales at
-- once — v1 occupies 0.7-1.0 and v3 occupies 0.6-0.8 with almost no overlap —
-- so a threshold learned from it can land above anything the current epoch
-- ever emits, silently halting trading instead of tightening it.
-- deriveEdge() calibrates from these rows, scoped to the running epoch.
confs_epoch AS (
  SELECT strategy_epoch AS epoch, conf_bucket AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy,
         coalesce(avg(gross_pnl), 0)::numeric AS gross_expectancy,
         coalesce(avg(entry_slip_bps + exit_slip_bps), 0)::numeric AS avg_slip_bps,
         coalesce(avg(confidence), 0)::numeric AS avg_confidence
  FROM closed GROUP BY strategy_epoch, conf_bucket
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
      -- Attribution only. gross_pnl is computed from the prices we actually
      -- FILLED at, so slippage is already inside it; subtracting it from gross
      -- would double-count. Never put this in the net identity.
      'slip_cost', coalesce(sum(slip_cost_usd), 0),
      -- net - (gross - fees - funding). Must be ~0 outside liquidations,
      -- whose pnl is capped at the margin rather than derived from the exit.
      'residual', coalesce(sum(pnl), 0)
                  - (coalesce(sum(gross_pnl), 0)
                     - coalesce(sum(fees), 0)
                     - coalesce(sum(funding), 0)),
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
  'confidence', coalesce((SELECT jsonb_agg(to_jsonb(confs)) FROM confs), '[]'::jsonb),
  'confidence_by_epoch',
    coalesce((SELECT jsonb_agg(to_jsonb(confs_epoch)) FROM confs_epoch), '[]'::jsonb)
);
$$;
