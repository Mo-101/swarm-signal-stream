-- Live (real-money) trading — separate from paper_accounts/paper_trades on
-- purpose, so a bug can never mix a real position into the paper-simulation
-- view or vice versa. provider is 'binance' | 'bybit'; one account per
-- (user, provider) since each venue has its own wallet/balance.
CREATE TABLE public.live_accounts (
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  provider text NOT NULL,
  realized_pnl numeric NOT NULL DEFAULT 0,
  halted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_accounts TO authenticated;
GRANT ALL ON public.live_accounts TO service_role;
ALTER TABLE public.live_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own live account" ON public.live_accounts FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.live_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
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
CREATE INDEX live_trades_user_status_idx ON public.live_trades (user_id, provider, status, opened_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_trades TO authenticated;
GRANT ALL ON public.live_trades TO service_role;
ALTER TABLE public.live_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own live trades" ON public.live_trades FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
