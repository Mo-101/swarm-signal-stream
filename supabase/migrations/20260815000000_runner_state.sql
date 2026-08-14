-- Heartbeat table for the headless runner. One row per user: when a live
-- heartbeat exists (updated in the last 60s), the dashboard treats the
-- runner as authoritative and switches to Observer mode instead of also
-- opening/closing paper trades itself.
CREATE TABLE public.runner_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'starting',
  equity numeric NOT NULL DEFAULT 0,
  closed_trades integer NOT NULL DEFAULT 0,
  ticks_per_sec numeric NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.runner_state TO authenticated;
GRANT ALL ON public.runner_state TO service_role;
ALTER TABLE public.runner_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own runner state" ON public.runner_state FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
