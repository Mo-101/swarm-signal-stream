import type { FundingStats } from "@/lib/paper-broker";
import type { RegimeStyle } from "@/lib/regime";

function usd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}`;
}
function pctRate(v: number): string {
  return `${(v * 100).toFixed(4)}%`;
}
function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}
/** "in 2h 13m" — read off the exchange's own next settlement, never computed. */
function countdown(at: number | null): string {
  if (at === null) return "—";
  const ms = at - Date.now();
  if (ms <= 0) return "due";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}
/** "8h", "4h", "1h", "30m" — whatever this contract actually runs on. */
function interval(ms: number): string {
  const hours = ms / 3_600_000;
  return hours >= 1 ? `${Number(hours.toFixed(2))}h` : `${Math.round(ms / 60_000)}m`;
}
const RATE_SOURCE_LABEL: Record<string, string> = {
  settled: "confirmed",
  live: "predicted",
  default: "assumed",
};

const REGIME_LABELS: Record<RegimeStyle, string> = {
  trend: "Trending",
  meanRevert: "Mean-reverting",
  breakout: "Breakout",
  chop: "Chop",
};

/**
 * Funding carry telemetry. Perp funding is the quiet tax on a paper book that
 * looks profitable gross: this panel makes the drag, the projected next
 * settlement, and the CARRY exit rule's effect explicit.
 */
export function FundingPanel({
  funding,
  regimeMix,
}: {
  funding: FundingStats;
  regimeMix: Record<RegimeStyle, number>;
}) {
  const mixTotal = Object.values(regimeMix).reduce((a, b) => a + b, 0);
  // "3 × 8h · 1 × 4h" — the open book's real schedules, not an assumed one.
  const intervalSummary = Object.entries(funding.intervalMix)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} × ${label}`)
    .join(" · ");

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="Net funding"
          value={usd(-funding.totalFunding)}
          sub={`paid ${usd(funding.paid)} · received ${usd(funding.received)} · ${funding.accruals} accruals`}
          tone={funding.totalFunding > 0 ? "bear" : "bull"}
        />
        <Card
          title="Drag on gross"
          value={`${funding.dragPctOfGross.toFixed(2)}%`}
          sub="share of gross PnL consumed by funding"
          tone={funding.dragPctOfGross > 10 ? "bear" : "neutral"}
        />
        <Card
          title="Open carry"
          value={usd(funding.openCarryUsd)}
          sub={`next settlement ${countdown(funding.nextFundingAt)} ≈ ${usd(
            funding.projectedNextUsd,
          )} · avg rate ${pctRate(funding.avgOpenRate)}`}
          tone={funding.projectedNextUsd > 0 ? "bear" : "neutral"}
        />
        <Card
          title="CARRY exits"
          value={String(funding.carryExits)}
          sub={`avoided ≈ ${usd(funding.carrySavedUsd)} · ${funding.timeExits} max-hold exits · ${funding.liveRates} live rates`}
          tone={funding.carryExits > 0 ? "bull" : "neutral"}
        />
      </div>

      <p className="text-[11px] text-muted-foreground">
        Funding is modeled per symbol from Bybit&apos;s live rate and its
        exchange-reported next settlement time. Intervals vary by contract and can
        change dynamically — nothing here assumes a fixed 8h schedule.
        {intervalSummary && <> Open book: {intervalSummary}.</>}
        {funding.scheduleChanges > 0 && (
          <> {funding.scheduleChanges} schedule change(s) followed this session.</>
        )}
        {funding.provisional > 0 && (
          <>
            {" "}
            {funding.provisional} settlement(s) charged at the predicted rate, awaiting
            confirmation from funding history.
          </>
        )}
      </p>

      {mixTotal > 0 && (
        <section className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Detected market styles</h3>
            <p className="text-xs text-muted-foreground">
              Which regime the swarm gated agents against, over {mixTotal} proposals
            </p>
          </div>
          <div className="space-y-2 px-4 py-3">
            {(Object.keys(REGIME_LABELS) as RegimeStyle[]).map((k) => {
              const share = mixTotal ? (regimeMix[k] / mixTotal) * 100 : 0;
              return (
                <div key={k} className="flex items-center gap-3">
                  <span className="w-28 text-[11px] text-muted-foreground">{REGIME_LABELS[k]}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-accent/60" style={{ width: `${share}%` }} />
                  </div>
                  <span className="w-24 text-right font-mono text-[11px] tabular text-muted-foreground">
                    {regimeMix[k]} · {share.toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-border">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Funding settlements</h3>
          <p className="text-xs text-muted-foreground">
            Every exchange settlement charged to an open position, newest first
          </p>
        </div>
        {funding.recent.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            No funding settlement has been reached yet.
          </div>
        ) : (
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {funding.recent.map((e, i) => (
              <li key={`${e.symbol}-${e.at}-${i}`} className="px-4 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs">
                    <span className={e.side === "BUY" ? "text-bull" : "text-bear"}>{e.side}</span>{" "}
                    {e.symbol}
                  </span>
                  <span
                    className={`font-mono text-xs tabular ${e.amount > 0 ? "text-bear" : "text-bull"}`}
                  >
                    {e.amount > 0 ? "-" : "+"}
                    {usd(Math.abs(e.amount))}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {interval(e.intervalMs)} settlement at {pctRate(e.rate)} (
                  {RATE_SOURCE_LABEL[e.rateSource] ?? e.rateSource}) on {usd(e.notional)}{" "}
                  notional — {e.quantity} @ mark {usd(e.markPrice)} · cumulative{" "}
                  {usd(e.cumulative)} · {time(e.at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Card({
  title,
  value,
  sub,
  tone,
}: {
  title: string;
  value: string;
  sub: string;
  tone: "bull" | "bear" | "neutral";
}) {
  const toneClass =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className={`mt-1 font-mono text-lg tabular ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{sub}</div>
    </div>
  );
}
