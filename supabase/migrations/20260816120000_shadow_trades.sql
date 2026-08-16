-- Durable per-trade record for the counterfactual shadow book.
--
-- runner_state.shadow only ever held the rolled-up ShadowStats blob, so every
-- restart discarded the underlying trades and restarted the evidence from
-- zero. This table persists each shadow trade on open and finalises it on
-- close, including the modeled fee and funding carry that net_usd folds in.
CREATE TABLE IF NOT EXISTS public.shadow_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
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
  ON public.shadow_trades (user_id, status, closed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shadow_trades TO authenticated;
GRANT ALL ON public.shadow_trades TO service_role;

ALTER TABLE public.shadow_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own shadow trades" ON public.shadow_trades FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
