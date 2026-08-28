<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture notes

- **Neon is the canonical DB** (`DATABASE_URL`); Supabase is a best-effort
  mirror/fallback only. The Supabase project domain currently NXDOMAINs, so
  nothing may hard-depend on it.
- **Auth**: Neon-local auth (`src/lib/auth/`) is canonical — `app_users` table,
  scrypt hashes, HS256 tokens signed with `LOCAL_AUTH_SECRET` (or derived from
  `DATABASE_URL`). Supabase JWTs are still accepted as fallback by
  `requireAuth` (`src/lib/auth/auth-middleware.ts`). Successful Supabase logins
  are mirrored into `app_users` with the same user id automatically.
- The runner (`runner/index.ts`) signs in via Supabase first, falls back to
  Neon local auth; the first env-credential (`RUNNER_EMAIL`/`RUNNER_PASSWORD`)
  local sign-in adopts the existing data-owner user id.

## Commands

- Dev server: `npx vite dev --host 0.0.0.0 --port 8080` (needs Node >= 20; use
  `nvm use 22` in WSL — system node is 18).
- Runner: `npx tsx runner/index.ts` (health endpoint on :8090/health).
- Verify: `npx tsc --noEmit` and `npx eslint <files>`.
- Docker (ONE container, dashboard + runner supervised by
  `docker/supervisor.mjs`): `docker compose up -d --build`. Ports 8085→8080
  (dashboard), 8090 (runner health). Secrets come from `.env` via compose
  `env_file` and are excluded from the image by `.dockerignore`.
- Apply Neon schema: `node scripts/apply-schema.mjs src/lib/db/schema.sql`
  with `DATABASE_URL` set. Idempotent, comment/dollar-quote safe, verifies
  `public.edge_report` exists afterwards, and no-ops when `DATABASE_URL` is
  unset. `scripts/deploy-vps.sh` runs it automatically on every deploy.

## Environment quirks

- On this WSL box (VPN/WireGuard), Node >= 20 needs
  `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000` or
  Neon/HTTPS fetches fail with ETIMEDOUT after ~250ms (happy-eyeballs). The
  Dockerfile sets this by default.
