# Get this repo's code onto the VPS without SSH

Confirmed live now at 31.97.180.251: runner `running`, equity $10,134.78, 5 open
positions, 80 closed trades, health `ok`. The box is healthy — the gap is that new
code here only reaches it when someone SSHes in and runs the deploy script.

I have no SSH access to the box from this environment, only its public HTTP ports.
So "push from here" has to work through an image the VPS pulls by itself.

## How the pipeline will work

```text
Lovable/GitHub main  ->  GitHub Actions build  ->  ghcr.io/mo-101/swarm-signal-stream:latest
                                                            |
                                    auto-pull watcher on the VPS (every 5 min)
                                                            |
                                             container replaced, logs preserved
```

## 1. Add an auto-update watcher to the VPS compose files

Add a second service (Watchtower, pinned image) to `docker-compose.prod.yml` and
`vps-compose.yml`:

- polls GHCR every 5 minutes for a new `:latest` digest of `alpha-swarm`
- recreates only that container, keeping ports, `.env`, and the `./logs` bind mount
- `--cleanup` so old images are pruned
- scoped by label so it never touches unrelated containers on the box
- reads the same GHCR credentials already in Docker's config for the private package

Result: every push to main is running on the VPS within ~5 minutes, no SSH.

## 2. Make the image swap safe for an engine holding open positions

- keep `stop_grace_period: 20s` so the runner flushes open work before exit
- confirm the runner reconciles open positions from Neon on boot (it loads boot
  state today; the plan verifies this path explicitly before enabling auto-pull,
  since 5 positions are open right now)
- container `healthcheck` on `:8090/health` so a bad image shows `unhealthy`
  instead of silently dying

## 3. Manual override kept

`./scripts/deploy-vps.sh` stays the immediate path (`git pull && ./scripts/deploy-vps.sh`),
plus a new `--pull-only` shortcut that skips the schema step when you just want
the newest image right now instead of waiting for the poll.

## 4. One-time VPS setup you run (once)

Because the watcher is new, it has to be started once by hand:

```bash
cd /docker/alpha-swarm
git pull
docker compose -f docker-compose.prod.yml up -d
```

After that, deploys are automatic.

## 5. Docs

`DEPLOY.md` gets an "Automatic updates" section: how the watcher works, how to
pause it (`docker compose stop watchtower`), and how to force an immediate update.

## Technical notes

- Watchtower is pinned to a specific tag, not `latest`, so the updater itself
  can't change under you.
- No trading logic, strategy parameters, or epoch config is touched — v3 keeps
  running through the swap.
- No secrets are added to the repo; GHCR auth reuses the existing host login.

## Not included

Direct push from this sandbox to the box (needs SSH or an inbound deploy webhook).
If you'd rather have a `POST /api/public/redeploy` webhook guarded by a shared
secret, say so and I'll swap section 1 for that instead.
