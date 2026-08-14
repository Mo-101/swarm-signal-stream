import { useMemo } from "react";
import type { ClosedTrade } from "@/lib/paper-broker";

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function usd(v: number) {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

/**
 * Review-sample progress tracker: how far the paper run is toward the
 * agreed closed-trade sample, how fast trades are closing, and the
 * live PnL / win-rate picture for that sample.
 */
export function ReviewProgress({
  closed,
  target,
  realized,
  unrealized,
  runStartedAt,
}: {
  closed: ClosedTrade[];
  target: number;
  realized: number;
  unrealized: number;
  runStartedAt: number | null;
}) {
  const stats = useMemo(() => {
    const n = closed.length;
    const wins = closed.filter((t) => t.pnl > 0).length;
    const winRate = n ? (wins / n) * 100 : 0;
    const remaining = Math.max(0, target - n);

    // Trades/hour from the most recent window of closes, falling back to the
    // whole run so an early sample still yields a usable estimate.
    const times = closed
      .map((t) => t.closedAt)
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    const window = times.slice(-20);
    let perMs = 0;
    if (window.length >= 2) {
      const span = window[window.length - 1]! - window[0]!;
      if (span > 0) perMs = (window.length - 1) / span;
    } else if (runStartedAt && n > 0) {
      const span = Date.now() - runStartedAt;
      if (span > 0) perMs = n / span;
    }
    const etaMs = perMs > 0 && remaining > 0 ? remaining / perMs : null;
    const lastCloseAgo = times.length ? Date.now() - times[times.length - 1]! : null;

    return {
      n,
      wins,
      losses: n - wins,
      winRate,
      remaining,
      tradesPerHour: perMs * 3_600_000,
      etaMs,
      lastCloseAgo,
    };
  }, [closed, target, runStartedAt]);

  const pct = Math.min(100, (stats.n / target) * 100);
  const done = stats.remaining === 0;
  const net = realized + unrealized;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">
          Review sample progress
        </h2>
        <span className="font-mono text-xs text-muted-foreground">
          {done
            ? "sample complete — ready for review"
            : stats.etaMs !== null
              ? `~${fmtDur(stats.etaMs)} to ${target} trades`
              : "estimating…"}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
          <div
            className={`h-full rounded-full transition-all ${done ? "bg-bull" : "bg-accent"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {stats.n}/{target}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          {
            label: "Remaining",
            value: done ? "0" : String(stats.remaining),
            tone: "neutral" as const,
          },
          {
            label: "Close rate",
            value:
              stats.tradesPerHour > 0 ? `${stats.tradesPerHour.toFixed(1)}/h` : "—",
            tone: "neutral" as const,
          },
          {
            label: "ETA",
            value: done ? "done" : stats.etaMs !== null ? fmtDur(stats.etaMs) : "—",
            tone: "neutral" as const,
          },
          {
            label: "Realized",
            value: usd(realized),
            tone: realized >= 0 ? ("bull" as const) : ("bear" as const),
          },
          {
            label: "Unrealized",
            value: usd(unrealized),
            tone: unrealized >= 0 ? ("bull" as const) : ("bear" as const),
          },
          {
            label: "Win rate",
            value: stats.n ? `${stats.winRate.toFixed(0)}%` : "—",
            tone: stats.winRate >= 50 ? ("bull" as const) : ("bear" as const),
          },
        ].map((c) => (
          <div key={c.label} className="rounded border border-border/60 p-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {c.label}
            </p>
            <p
              className={`mt-0.5 font-mono text-sm tabular-nums ${
                c.tone === "bull"
                  ? "text-bull"
                  : c.tone === "bear"
                    ? "text-bear"
                    : "text-foreground"
              }`}
            >
              {c.value}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-2 font-mono text-[10px] text-muted-foreground">
        {stats.wins}W / {stats.losses}L · net PnL {usd(net)}
        {stats.lastCloseAgo !== null
          ? ` · last close ${fmtDur(stats.lastCloseAgo) === "—" ? "<1m" : fmtDur(stats.lastCloseAgo)} ago`
          : " · no closes yet"}
      </p>
    </section>
  );
}
