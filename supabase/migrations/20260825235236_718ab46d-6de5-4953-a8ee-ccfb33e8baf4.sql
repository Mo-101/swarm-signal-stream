UPDATE public.paper_trades
SET status = 'abandoned',
    reason = COALESCE(reason, 'STALE'),
    closed_at = COALESCE(closed_at, now())
WHERE status = 'open'
  AND strategy_epoch = 'v1'
  AND opened_at < now() - interval '3 days';