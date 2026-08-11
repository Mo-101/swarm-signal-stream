CREATE TABLE public.paper_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  starting_balance numeric NOT NULL DEFAULT 10000,
  realized_pnl numeric NOT NULL DEFAULT 0,
  halted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_accounts TO authenticated;
GRANT ALL ON public.paper_accounts TO service_role;
ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own paper account" ON public.paper_accounts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
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
  UNIQUE (user_id, client_id)
);
CREATE INDEX paper_trades_user_status_idx ON public.paper_trades (user_id, status, opened_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_trades TO authenticated;
GRANT ALL ON public.paper_trades TO service_role;
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own paper trades" ON public.paper_trades FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
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
CREATE INDEX signals_user_created_idx ON public.signals (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.signals TO authenticated;
GRANT ALL ON public.signals TO service_role;
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own signals" ON public.signals FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.edge_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH closed AS (
  SELECT * FROM public.paper_trades
  WHERE user_id = auth.uid() AND status = 'closed' AND pnl IS NOT NULL
),
agents AS (
  SELECT a.key AS name,
         count(*)::int AS trades,
         count(*) FILTER (WHERE c.pnl > 0)::int AS wins,
         coalesce(sum(c.pnl), 0)::numeric AS pnl,
         coalesce(avg(c.pnl), 0)::numeric AS expectancy
  FROM closed c, jsonb_each(c.agents) a
  WHERE (a.value->>'direction') = c.side
  GROUP BY a.key
),
symbols AS (
  SELECT symbol AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy
  FROM closed GROUP BY symbol
),
regimes AS (
  SELECT regime AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy
  FROM closed GROUP BY regime
),
hours AS (
  SELECT hour_utc::text AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy
  FROM closed GROUP BY hour_utc
),
confs AS (
  SELECT conf_bucket AS name, count(*)::int AS trades,
         count(*) FILTER (WHERE pnl > 0)::int AS wins,
         coalesce(sum(pnl), 0)::numeric AS pnl,
         coalesce(avg(pnl), 0)::numeric AS expectancy,
         coalesce(avg(confidence), 0)::numeric AS avg_confidence
  FROM closed GROUP BY conf_bucket
)
SELECT jsonb_build_object(
  'totals', (SELECT jsonb_build_object(
      'trades', count(*)::int,
      'wins', count(*) FILTER (WHERE pnl > 0)::int,
      'pnl', coalesce(sum(pnl), 0),
      'expectancy', coalesce(avg(pnl), 0)) FROM closed),
  'agents', coalesce((SELECT jsonb_agg(to_jsonb(agents)) FROM agents), '[]'::jsonb),
  'symbols', coalesce((SELECT jsonb_agg(to_jsonb(symbols)) FROM symbols), '[]'::jsonb),
  'regimes', coalesce((SELECT jsonb_agg(to_jsonb(regimes)) FROM regimes), '[]'::jsonb),
  'hours', coalesce((SELECT jsonb_agg(to_jsonb(hours)) FROM hours), '[]'::jsonb),
  'confidence', coalesce((SELECT jsonb_agg(to_jsonb(confs)) FROM confs), '[]'::jsonb)
);
$$;
GRANT EXECUTE ON FUNCTION public.edge_report() TO authenticated;