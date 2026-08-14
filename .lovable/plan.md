# Headless runner: keep the swarm trading 24/7 on a VPS

Today the whole engine lives inside the dashboard page, so trading only happens while a browser tab is open. This adds a second way to run the exact same engine: a standalone process you can start on a VPS (or your own laptop) that keeps streaming, trading and persisting with no browser at all.

Vercel is left out on purpose: its serverless functions can't hold the long-lived WebSocket connections the feed needs, so a runner there would silently stop trading. VPS (always-on) and local are covered.

## What gets built

### 1. Extract the trading brain out of the page
The orchestration that currently lives in the dashboard component — feeding ticks into agents, applying learned weights, opening/closing paper positions, funding accrual, liquidation checks, persistence — moves into one shared, browser-free module. Both the dashboard and the runner then drive that same module, so there is exactly one implementation of the strategy and no risk of the VPS behaving differently from the preview.

### 2. The runner process
A small entrypoint that:
- signs in to the cloud database as a dedicated bot user (email + password from its own env file),
- loads existing account state, trades and learned edge weights so it resumes rather than restarts,
- starts the swarm engine and paper broker,
- persists every open/close immediately,
- writes a heartbeat every 15s (status, equity, closed-trade count, tick rate, uptime),
- logs a compact status line each minute and shuts down cleanly on stop/restart.

### 3. Runner is authoritative
A `runner_state` table holds the heartbeat. When a live heartbeat exists (seen in the last 60s), the dashboard switches to **Observer mode**: it keeps streaming prices and rendering everything, but does not open or close paper trades itself. A banner shows "Runner active on VPS · observing" with uptime and last-seen. If the heartbeat goes stale, the dashboard offers to take over trading again. This keeps the 100-trade review sample clean of duplicate entries.

### 4. Deployment kit
- `runner/.env.example` listing every variable needed.
- `Dockerfile.runner` + `docker-compose.runner.yml` for a one-command VPS start with auto-restart.
- A systemd unit file for the non-Docker route.
- `RUNNER.md` with copy-paste steps: create the bot user, fill env, `docker compose up -d`, check logs, verify the dashboard shows Observer mode.
- Local run: same command with `bun run runner`.

### 5. Bot account setup
The runner needs its own login. You'll create it once from the auth screen (or I can add a one-off signup helper), then its email/password go in the VPS env file. Its trades land under that user, so the dashboard should be signed in as the same account to see them — I'll confirm which account you want to use before wiring it.

## Technical notes

- New shared module `src/lib/engine-runtime.ts` holding the loop currently inlined in `src/routes/_authenticated/dashboard.tsx`; `swarm.ts`, `paper-broker.ts`, `microstructure.ts` are already portable apart from the `window`/`document` wake listeners in `swarm.ts`, which get guarded and replaced by an interval watchdog when not in a browser.
- Runner entrypoint at `runner/index.ts`, run under Bun (Node 22 also works — both have native `WebSocket`).
- Persistence from the runner goes straight through `@supabase/supabase-js` with the publishable key and a password sign-in, so existing RLS applies unchanged; it does not call the app's server functions.
- New migration: `runner_state` (user_id PK, status, equity, closed_trades, ticks_per_sec, started_at, last_seen_at) with GRANTs and owner-scoped RLS policies.
- Dashboard subscribes to `runner_state` and gates its own trade-execution effects on `!runnerActive`.
- While in the shared-module extraction I'll also trim the in-memory signal buffer retention, which is the source of the current out-of-memory measure errors in long sessions.

## Order of work

1. Extract engine runtime; dashboard keeps working unchanged.
2. `runner_state` migration + heartbeat + dashboard observer mode.
3. Runner entrypoint, Docker/systemd files, RUNNER.md.
4. Verify locally: start runner, watch dashboard flip to observer and trades keep accruing.
