# Keep paper running to 100 trades

## The one thing to know first

Publishing does **not** make the swarm run on a server. The agents, the WebSocket feeds and the paper broker all run inside the browser tab. The trades and the edge report are saved to the cloud database, so nothing is lost when the tab closes — but no new trades accumulate while no tab is open.

So "non-stop running" means: one tab, somewhere, left open. Publishing helps because that tab can be a spare laptop, a second monitor, or a phone instead of the editor preview.

On visibility: the dashboard already sits behind sign-in, so publishing it publicly still requires your account to view it. Private publishing is a Business/Enterprise plan feature and would add nothing here. Recommendation: publish normally and rely on the existing auth gate.

## What to build

### 1. Survive a long unattended run
Currently a backgrounded tab gets its timers throttled, and a dropped feed can sit dead until someone notices.

- Auto-reconnect the market feeds on `visibilitychange`, `online`, and on a stall watchdog (no ticks for 60s → rebuild the socket).
- Make the persistence flush event-driven (on every open/close) rather than interval-driven, so a throttled tab still records every trade.
- Optional Screen Wake Lock toggle so a dedicated device does not sleep.
- Show "running for Xh Ym · last tick Ns ago" in the header so a dead run is obvious at a glance.

### 2. A visible run-to-100 milestone
- Progress bar in the header: `closed trades / 100`.
- Hard lock: the live-arm button stays disabled until 100 closed paper trades exist, regardless of venue readiness. The circuit breaker and venue probe stay as they are.
- A "Review" banner appears at 100 with a link to the Edge tab.

### 3. The review pack at 100 trades
A one-screen summary you can judge in a minute, on the Edge tab:

- Net PnL after fees, funding and slippage, versus gross alpha PnL.
- Win rate, average win/loss, largest drawdown, longest losing streak.
- Per-agent net edge with its trust level and sample count.
- Per-symbol net edge, highlighting cost-suppressed symbols.
- The verdict line: whether the net edge clears the round-trip cost hurdle with enough samples to be trusted.

## Live connection

Left alone. Live mode stays disarmed and untouched — no sizing work, no venue changes. The only live-related change is the 100-trade lock in section 2, which keeps it from being armed by accident during the run.

## Technical notes

- Reconnect/watchdog logic goes in `src/lib/swarm.ts` alongside the existing `SwarmMetrics`; the dashboard already renders the connection state in the System tab.
- The 100-trade gate reads the closed-trade count that already flows into the Edge model, and combines with the existing `liveArmed` probe flag in `src/routes/_authenticated/dashboard.tsx`.
- The review pack extends `src/components/EdgePanel.tsx` and reuses the rolling-window and trust-level values already computed in `src/lib/edge-model.ts`.
- No change to the paper engine's mechanics — fees, funding, margin and liquidation stay as they are so the 100 trades are measured consistently.

## Order of work

1. Reconnect hardening, run-time indicator, event-driven persistence.
2. Run-to-100 progress and the live lock.
3. Publish so the run can live on a spare device.
4. Review pack on the Edge tab.
