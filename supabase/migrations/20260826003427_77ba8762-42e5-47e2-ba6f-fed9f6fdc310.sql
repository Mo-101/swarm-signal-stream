CREATE TABLE IF NOT EXISTS public.runner_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'starting',
  equity numeric NOT NULL DEFAULT 0,
  closed_trades integer NOT NULL DEFAULT 0,
  ticks_per_sec numeric NOT NULL DEFAULT 0,
  shadow jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.runner_state ADD COLUMN IF NOT EXISTS shadow jsonb;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.runner_state TO authenticated;
GRANT ALL ON public.runner_state TO service_role;
ALTER TABLE public.runner_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own runner state" ON public.runner_state;
CREATE POLICY "own runner state" ON public.runner_state FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.daemon_state (
  id text PRIMARY KEY,
  locked_until timestamptz,
  paused boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  last_status text,
  last_result jsonb,
  consecutive_errors integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.daemon_state TO authenticated;
GRANT ALL ON public.daemon_state TO service_role;
ALTER TABLE public.daemon_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "daemon state readable" ON public.daemon_state;
CREATE POLICY "daemon state readable" ON public.daemon_state FOR SELECT TO authenticated USING (true);