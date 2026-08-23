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
          sub={`next 8h boundary ≈ ${usd(funding.projectedNext8hUsd)} · avg rate ${pctRate(funding.avgOpenRate)}`}
          tone={funding.projectedNext8hUsd > 0 ? "bear" : "neutral"}
        />
        <Card
          title="CARRY exits"
          value={String(funding.carryExits)}
          sub={`avoided ≈ ${usd(funding.carrySavedUsd)} · ${funding.timeExits} max-hold exits · ${funding.liveRates} live rates`}
          tone={funding.carryExits > 0 ? "bull" : "neutral"}
        />
      </div>

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
            Every 8h boundary charged to an open position, newest first
          </p>
        </div>
        {funding.recent.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">
            No funding boundary has been crossed yet.
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
                  {e.intervals}× interval at {pctRate(e.rate)} {e.liveRate ? "(live)" : "(default)"}{" "}
                  on {usd(e.notional)} notional · cumulative {usd(e.cumulative)} · {time(e.at)}
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
