# Wrap the working VPS state into repeatable repo automation

Goal: a clean `git clone` + one command on a fresh VPS reproduces exactly what is running now at `/docker/alpha-swarm` — one healthy container, dashboard on 8085, runner health on 8090, Neon schema (including `edge_report`) applied automatically, persistent rotated logs, no secrets printed anywhere.

## 1. Compose files

`docker-compose.prod.yml` already matches the live setup. Bring `vps-compose.yml` in line so either file works identically:

- add `stop_grace_period: 20s`
- keep single `alpha-swarm` service, `8085:8080` + `8090:8090`, `restart: always`, `pull_policy: always`
- keep `LOG_DIR=/app/logs`, `./logs:/app/logs`, json-file rotation (10m x 5, matching prod)
- add a container `healthcheck` hitting `http://localhost:8090/health` so `docker ps` shows healthy/unhealthy directly
- add the same healthcheck to `docker-compose.prod.yml`

## 2. Robust Neon schema apply

Replace the throwaway `.scratch-apply-schema.mjs` with a committed `scripts/apply-schema.mjs`:

- strip line comments only outside string/dollar-quote literals
- split statements on semicolons only outside `'...'`, `"..."`, and `$tag$...$tag$` bodies (current version only handles bare `$$` and drops comment-leading statements)
- run every statement; the whole schema is already written idempotently (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ADD COLUMN IF NOT EXISTS`)
- verify afterwards that `edge_report(uuid, text)` exists via `pg_proc`, and fail loudly if not
- read `DATABASE_URL` from env; never echo it — log only host-less summaries like `Applied 41 statements`
- exit 0 with a clear "skipped — DATABASE_URL not set" when Neon is not configured, so deploys on Supabase-only hosts don't break

Delete `.scratch-apply-schema.mjs` and point any docs at the new script.

## 3. `scripts/deploy-vps.sh` rewrite

Order of operations:

1. resolve compose file (`docker-compose.prod.yml` by default, `docker-compose.yml` with `--build`), preflight with `docker compose config -q`
2. `mkdir -p logs`
3. `.env` optional rather than fatal (the Hostinger panel injects env), but warn when absent
4. pull (or build) the image
5. apply Neon schema **inside the freshly pulled image** so no Node toolchain is needed on the host:
   `docker compose run --rm --no-deps alpha-swarm node scripts/apply-schema.mjs src/lib/db/schema.sql`
   (schema file + script get copied into the image — see technical notes)
6. `docker compose up -d`
7. wait up to 180 s for both `http://localhost:8085/api/public/health` and `http://localhost:8090/health`
8. on failure: print `docker compose ps`, last 80 lines of container logs, and the last 40 lines of `logs/runner.log` — all already secret-free
9. on success: print the three verification URLs and prune dangling images

Add `set -euo pipefail`, and a `--no-schema` flag to skip step 5.

## 4. Health: Supabase must not drag status down

In `src/lib/health/checks.server.ts`:

- `checkDaemon`: when Supabase is not configured (or the admin client can't be constructed / host doesn't resolve), return `state: "skipped"` with "Supabase fallback not configured — VPS runner is the primary engine" instead of `degraded`. Keep `degraded` only when Supabase *is* configured and the read genuinely fails.
- `checkAuth`: unchanged behaviour when Neon is up; the Supabase note stays informational.
- Confirm `rollup()` treats `skipped` as non-failing (verify while editing) so overall status stays `ok` and `notify()` doesn't page the webhook.

## 5. DEPLOY.md rewrite

- exact VPS paths and commands used live:
  ```
  cd /docker/alpha-swarm
  git pull
  ./scripts/deploy-vps.sh
  docker compose -f docker-compose.prod.yml up -d
  curl -s localhost:8090/health | jq
  curl -s localhost:8085/api/public/health | jq
  tail -f logs/runner.log
  ```
- logs section: `logs/dashboard.log`, `logs/runner.log`, rotation, survive container replacement
- restart semantics: supervisor restarts each half with exponential backoff; crash-loop exits the container so `restart: always` recreates it
- schema section: automatic on deploy; manual fallback `node scripts/apply-schema.mjs src/lib/db/schema.sql`
- firewall section: Hostinger panel firewall **and** UFW must allow TCP 8085/8090 (`sudo ufw allow 8085/tcp`, `sudo ufw allow 8090/tcp`), plus the recommended alternative of a Caddy/Nginx reverse proxy on 80/443 with the raw ports closed
- Supabase noted as optional fallback; Neon canonical
- placeholders only for secrets, no real values

## 6. Secret hygiene pass

Audit the deploy script, apply-schema script, and DEPLOY.md so nothing echoes `DATABASE_URL`, API keys, tokens, or `.env` contents; failure output is restricted to compose/app logs which already redact.

## Technical notes

- `Dockerfile` must copy `scripts/apply-schema.mjs` and `src/lib/db/schema.sql` into the runtime image for step 5 to work; will verify and add if the current build prunes them.
- `@neondatabase/serverless` is already a dependency, so the apply script runs in the image without extra installs.
- No trading logic, strategy parameters, or epoch configuration is touched — v3 keeps running uninterrupted.

## Acceptance check after implementation

- `docker compose -f docker-compose.prod.yml config -q` passes
- `node scripts/apply-schema.mjs` parses the full schema into statements and reports `edge_report` present (dry parse verifiable locally without a DB)
- typecheck passes; health rollup returns `ok` with Supabase unconfigured
