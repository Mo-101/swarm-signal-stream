-- One row per funding settlement charged to a paper position.
--
-- Funding used to be charged off a hard-coded 00:00 / 08:00 / 16:00 UTC grid,
-- with no record of the individual settlements. That was wrong in two ways:
-- Bybit's funding interval is per-contract (8h, 4h, 1h) and can change
-- dynamically, and a restart re-derived the schedule from scratch with no way
-- to tell an already-charged settlement from a missed one.
--
-- funding_time is the EXCHANGE's settlement timestamp — Bybit's
-- nextFundingTime, later confirmed as fundingRateTimestamp — never a locally
-- computed boundary. The UNIQUE constraint on it is the durable half of the
-- engine's idempotency: the broker holds an in-memory set of settled
-- boundaries, and this makes that survive a process restart. A replayed or
-- double-delivered settlement hits ON CONFLICT DO NOTHING and can never reach
-- the ledger twice.
CREATE TABLE IF NOT EXISTS public.paper_funding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  -- The position this was charged to (PaperBroker position id).
  client_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  funding_time timestamptz NOT NULL,
  -- Position quantity AT settlement. Bybit charges on the size held at the
  -- settlement instant, not an average over the interval.
  position_qty numeric NOT NULL,
  -- Mark price at settlement. Position value is position_qty x mark_price;
  -- entry price and last-traded price are both wrong here.
  mark_price numeric NOT NULL,
  funding_rate numeric NOT NULL,
  -- This contract's settlement period when the charge was made.
  interval_ms bigint NOT NULL,
  notional numeric NOT NULL,
  -- Signed as the ledger sees it: positive = the position PAID.
  amount_usd numeric NOT NULL,
  -- 'settled' = confirmed against history-fund-rate and final.
  -- 'live'    = provisional, charged at the ticker's predicted rate.
  -- 'default' = no exchange rate was available.
  rate_source text NOT NULL DEFAULT 'live',
  strategy_epoch text NOT NULL DEFAULT 'v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, side, funding_time)
);

CREATE INDEX IF NOT EXISTS paper_funding_events_user_time_idx
  ON public.paper_funding_events (user_id, funding_time DESC);

-- Settlements still awaiting their confirmed rate, for the reconciliation pass.
CREATE INDEX IF NOT EXISTS paper_funding_events_provisional_idx
  ON public.paper_funding_events (user_id, rate_source)
  WHERE rate_source <> 'settled';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_funding_events TO authenticated;
GRANT ALL ON public.paper_funding_events TO service_role;

ALTER TABLE public.paper_funding_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own funding events" ON public.paper_funding_events FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
