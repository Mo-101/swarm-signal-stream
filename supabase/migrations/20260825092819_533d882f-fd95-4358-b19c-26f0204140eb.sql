CREATE TABLE public.binance_demo_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  trade_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  phase TEXT NOT NULL,
  strategy_epoch TEXT NOT NULL DEFAULT 'v3',
  order_type TEXT NOT NULL,
  requested_qty DOUBLE PRECISION NOT NULL,
  requested_price DOUBLE PRECISION,
  paper_price DOUBLE PRECISION,
  fill_price DOUBLE PRECISION,
  fill_qty DOUBLE PRECISION,
  slippage_bps DOUBLE PRECISION,
  exchange_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX binance_demo_orders_user_trade_idx ON public.binance_demo_orders (user_id, trade_id);
CREATE INDEX binance_demo_orders_created_idx ON public.binance_demo_orders (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.binance_demo_orders TO authenticated;
GRANT ALL ON public.binance_demo_orders TO service_role;
ALTER TABLE public.binance_demo_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own binance demo orders" ON public.binance_demo_orders
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.binance_demo_control (
  user_id UUID NOT NULL PRIMARY KEY,
  armed BOOLEAN NOT NULL DEFAULT false,
  disarm_reason TEXT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.binance_demo_control TO authenticated;
GRANT ALL ON public.binance_demo_control TO service_role;
ALTER TABLE public.binance_demo_control ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own binance demo control" ON public.binance_demo_control
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);