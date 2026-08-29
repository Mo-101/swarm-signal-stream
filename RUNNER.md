# Headless runner

The dashboard's trading loop only runs while a browser tab has the page
open. The runner is the same engine (`src/lib/engine-runtime.ts` — one
implementation, no risk of the VPS behaving differently from the preview)
running as a standalone process, so the swarm keeps trading, learning and
persisting with nobody watching.

Vercel is intentionally not an option: serverless functions can't hold the
long-lived WebSocket connections the price feed needs. Use a VPS or your own
machine.

## 1. Apply the database migration

`supabase/migrations/20260815000000_runner_state.sql` adds the `runner_state`
heartbeat table this depends on. It has **not** been applied to the live
database yet — I don't have a Supabase credential that can run DDL. Apply it
the same way you apply the project's other migrations (Supabase dashboard SQL
editor, `supabase db push`, or however Lovable Cloud syncs migrations for
this project), then regenerate `src/integrations/supabase/types.ts` — I hand-
wrote the `runner_state` entry in there to match the migration exactly, but
it's a stopgap until the real codegen runs against the live schema.

## 2. Create the bot account

The runner needs its own login, separate from yours. Go to the app's `/auth`
screen and sign up with a dedicated email — don't reuse your personal
account. Its trades land under that user, so **the dashboard must be signed
in as this same account** to see them and to flip into Observer mode.

## 3. Configure the runner

```bash
cp runner/.env.example runner/.env
# SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are pre-filled (same values as the
# repo-root .env.example); add RUNNER_EMAIL / RUNNER_PASSWORD for the bot
# account from step 2, plus Bybit keys if you trade live.
#
# Neon + Supabase run together: DATABASE_URL (Neon) powers login (app_users)
# and the live_trades ledger; Supabase stays the trade database. Leave
# DATA_STORE=neon is the canonical VPS configuration.
```

## 4. Run it

**Docker (recommended for a VPS):**

```bash
docker compose -f docker-compose.runner.yml up -d --build
docker compose -f docker-compose.runner.yml logs -f
```

Unlike the main `alpha-swarm` service, this compose file still uses a local
`build:` — it isn't published to GHCR. If you deploy it through a platform
that only uploads the compose file (like the Hostinger path we used for the
dashboard), it'll hit the same "can't build from a Dockerfile" problem, and
would need the same GHCR-publish treatment. Not set up yet — say the word if
you want that too.

**Bare Node / systemd (no Docker):**

```bash
npm install
npm run runner
```

Or install `runner/alpha-swarm-runner.service` under systemd (edit the
`User=` and `WorkingDirectory=` first):

```bash
sudo cp runner/alpha-swarm-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now alpha-swarm-runner
sudo journalctl -u alpha-swarm-runner -f
```

## 5. Verify

- Runner logs should show `[runner] engine started` followed by periodic
  `[runner] uptime=...` lines once a minute.
- Open the dashboard **signed in as the bot account**. Within ~10s a banner
  should appear: "Runner active on VPS · observing" with uptime and equity.
  While that banner is showing, the dashboard is display-only — it won't
  open/close trades itself, and its "Close All" / "Reset" buttons are
  disabled, so the two processes can never race on the same positions.
- If the banner doesn't show up, the runner's heartbeat isn't landing —
  check `runner_state` has a row for the bot user and that `last_seen_at`
  is recent (the dashboard treats anything older than 60s as stale).

## What actually changed

- `src/lib/engine-runtime.ts` — the trading brain (agents → combiner →
  broker → persistence, tick handling, funding, microstructure tracking),
  factored out of `dashboard.tsx`'s big effect so both the browser and the
  runner drive the exact same code.
- `runner/index.ts`, `runner/db.ts` — the standalone process: signs in as
  the bot user, loads existing state so it resumes instead of restarting,
  drives the shared engine, persists every open/close straight through
  `@supabase/supabase-js` (RLS applies unchanged, same as any signed-in
  user), and writes a heartbeat every 15s.
- `dashboard.tsx` now polls `runner_state`; when a heartbeat is fresh it
  passes `readOnly: true` into the shared engine (ticks and the board still
  render, but proposals never execute locally) and periodically re-hydrates
  from the DB so it shows what the runner is actually doing.
