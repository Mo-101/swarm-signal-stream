-- Grid control plane: desired state (what the user asked for) separated from
-- runtime state (what the runner is actually doing).
--
-- The web process never calls configureGrid(). It writes intent here and bumps
-- config_version. The runner claims the row, applies it, and sets
-- applied_version. So:
--
--   config_version > applied_version  ->  runner has unapplied work
--   config_version = applied_version  ->  synchronized
--
-- which makes the reconcile loop idempotent: replaying it changes nothing.
--
-- Written as ALTERs rather than a drop/recreate so it is safe to run against a
-- table that already holds rows.
ALTER TABLE futures_grid_state
  ADD COLUMN IF NOT EXISTS desired_state text NOT NULL DEFAULT 'stopped';

ALTER TABLE futures_grid_state
  ADD COLUMN IF NOT EXISTS runtime_status text NOT NULL DEFAULT 'idle';

ALTER TABLE futures_grid_state
  ADD COLUMN IF NOT EXISTS config_version bigint NOT NULL DEFAULT 1;

ALTER TABLE futures_grid_state
  ADD COLUMN IF NOT EXISTS applied_version bigint NOT NULL DEFAULT 0;

ALTER TABLE futures_grid_state
  ADD COLUMN IF NOT EXISTS claimed_by text;

ALTER TABLE futures_grid_state
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

ALTER TABLE futures_grid_state
  ADD COLUMN IF NOT EXISTS last_error text;

-- runtime_state is absent until the runner has actually configured the grid.
ALTER TABLE futures_grid_state
  ALTER COLUMN runtime_state DROP NOT NULL;

-- Superseded by desired_state/runtime_status.
ALTER TABLE futures_grid_state
  DROP COLUMN IF EXISTS active;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'futures_grid_state_desired_state_check'
  ) THEN
    ALTER TABLE futures_grid_state
      ADD CONSTRAINT futures_grid_state_desired_state_check
      CHECK (desired_state IN ('stopped', 'running'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'futures_grid_state_runtime_status_check'
  ) THEN
    ALTER TABLE futures_grid_state
      ADD CONSTRAINT futures_grid_state_runtime_status_check
      CHECK (runtime_status IN ('idle','starting','running','halted','stopping','error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS futures_grid_state_desired_idx
  ON futures_grid_state (desired_state);

CREATE INDEX IF NOT EXISTS futures_grid_state_runtime_idx
  ON futures_grid_state (runtime_status);

DROP INDEX IF EXISTS futures_grid_state_active_idx;
