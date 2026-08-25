# Binance demo (testnet) execution for the v3 swarm

Goal: let the Alpha Swarm place real orders on Binance USDT-M **Futures Testnet** using the current v3 ruleset, executed from the always-on VPS runner, with a full mirror into the paper ledger so live fills can be graded against simulated ones.

## Decisions locked in

- Orders originate from the **VPS runner**, not the dashboard backend. The app's server region gets a CloudFront 403 on `testnet.binancefuture.com`; the runner's host does not have that problem, and the runner keeps trading with no browser tab open.
- Signal source is **epoch v3** exactly as it runs today — wide ATR stops (3.5x, 150-450 bps), 2:1 reward, passive maker entry, cost gating. No geometry changes.
- **No caps** requested. Testnet funds are fake, so the only limits kept are the ones already inside the engine (5 concurrent positions, 1% risk per trade, daily drawdown breaker). These stay because removing them would change v3's behaviour and pollute the A/B.

## What gets built

### 1. Runner-side Binance executor
A new executor module in the runner that mirrors the existing Bybit grid executor's shape:
- Reads `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_SECRET`, HMAC-SHA256 signed, base `https://testnet.binancefuture.com`.
- Startup probe (`/fapi/v2/account`) before anything is armed; the runner logs equity and marks execution ready. Failure leaves the runner paper-only rather than error-spamming.
- Symbol filter cache from `/fapi/v1/exchangeInfo` so quantity/price are rounded to tick and step size before submit.

### 2. Wire it to the v3 signal path
- When the paper broker opens a v3 position, the runner submits the matching Binance order: entry (post-only limit at the touch when the signal is non-urgent, market otherwise — same rule the paper broker uses), plus stop-loss and take-profit as reduce-only orders at the bracket prices the broker computed.
- Broker-side exits (breakeven ratchet, trail, carry/time exit) cancel and re-place the protective orders so the exchange state tracks the engine state.
- Position reconciliation loop every 30s against `/fapi/v2/positionRisk`: anything on the exchange the engine doesn't know about is flagged and closed; anything the engine holds that the exchange lost is flagged in the health report.

### 3. Paper/live parity ledger
Every Binance demo order writes a row alongside the paper trade with the same trade id, so we can compute per-symbol **live fill vs simulated fill** difference in bps. This is what tells us whether the microstructure model is honest before real money.

### 4. Dashboard + health
- Execution tab gets a Binance demo section: armed/blocked state, testnet equity, open exchange positions, and the live-vs-paper fill delta.
- `/api/public/health` gains a `binance_demo` component reporting probe result, key source, and the CloudFront-403 case with its own explicit hint (network block, not a key problem).
- Kill switch: one control that disarms Binance submission instantly and leaves paper running.

### 5. Deployment
- `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_SECRET` added to `.env.example` and `runner/.env.example`, plus a `BINANCE_DEMO_ENABLED` flag defaulting off so an image rollout never starts submitting by surprise.
- Runner health endpoint reports the Binance arm state so the VPS deploy script can verify it.

## What you need to do

Create a Binance Futures Testnet key at `testnet.binancefuture.com` (Futures permission enabled, no IP whitelist), and I'll save the pair as project secrets. Nothing arms until that probe returns an account balance.

## Technical notes

- New: `runner/binance-executor.ts` (signing, filters, probe, order helpers) and a thin runtime bridge next to `runner/grid-runtime.ts`.
- Existing `src/lib/live-trader.functions.ts` stays as the dashboard-side read path (status, positions, history) and is not used for submission; its CloudFront-403 detection already produces the right message when the app region is blocked.
- Order flow reuses the broker's already-computed entry/stop/target prices — no second sizing model, so paper and demo cannot diverge in intent, only in fill.
- v3 A/B measurement is unaffected: the paper ledger keeps recording as it does now; Binance rows are additive.
