import {
  winRate,
  rollingEdge,
  edgeDrift,
  type EdgeReport,
  type EdgeRow,
  type LearnedEdge,
  type RollingTrade,
  type TrustLevel,
} from "@/lib/edge-model";

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}
function usd(v: number) {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

const TRUST_CLASS: Record<TrustLevel, string> = {
  none: "border-border text-muted-foreground",
  low: "border-accent/50 text-accent",
  medium: "border-emerald-500/40 text-emerald-400",
  high: "border-emerald-500/70 text-emerald-400",
};

function TrustBadge({ level, sample }: { level: TrustLevel; sample: number }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${TRUST_CLASS[level]}`}
    >
      {level} · n={sample}
    </span>
  );
}


function EdgeTable({
  title,
  subtitle,
  rows,
  emptyLabel,
}: {
  title: string;
  subtitle: string;
  rows: EdgeRow[];
  emptyLabel: string;
}) {
  const sorted = [...rows].sort((a, b) => b.expectancy - a.expectancy).slice(0, 12);
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h3 className="text-xs font-medium text-foreground">{title}</h3>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{subtitle}</p>
      {sorted.length === 0 ? (
        <p className="mt-3 text-[11px] text-muted-foreground">{emptyLabel}</p>
      ) : (
        <table className="mt-2 w-full text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">Key</th>
              <th className="py-1 text-right font-normal">N</th>
              <th className="py-1 text-right font-normal">Win</th>
              <th className="py-1 text-right font-normal">Exp/trade</th>
              <th className="py-1 text-right font-normal">PnL</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className="border-t border-border/50">
                <td className="py-1 font-mono text-foreground">{r.name}</td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">{r.trades}</td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {pct(winRate(r))}
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${r.expectancy >= 0 ? "text-emerald-400" : "text-red-400"}`}
                >
                  {usd(r.expectancy)}
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${r.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
                >
                  {usd(r.pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function EdgePanel({
  report,
  learned,
  storedSignals,
  storedTrades,
  persistError,
  closedTrades = [],
}: {
  report: EdgeReport;
  learned: LearnedEdge;
  storedSignals: number;
  storedTrades: number;
  persistError: string | null;
  closedTrades?: RollingTrade[];
}) {
  const t = report.totals;
  const windows = rollingEdge(closedTrades);
  const drift = edgeDrift(closedTrades);
  return (
    <div className="space-y-3">
      {persistError && (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          Storage error: {persistError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Closed trades (stored)", value: String(t.trades) },
          { label: "Win rate", value: pct(winRate(t)) },
          { label: "Expectancy / trade", value: usd(t.expectancy) },
          { label: "Cumulative PnL", value: usd(t.pnl) },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.label}</p>
            <p className="mt-1 text-sm font-medium tabular-nums text-foreground">{c.value}</p>
          </div>
        ))}
      </div>

      <section className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium text-foreground">Sample size & trust</h3>
          <TrustBadge level={learned.trust} sample={learned.sample} />
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Agent weights only move once a bucket has at least {learned.minBucketSample} closed
          trades. Below that the base weight is held and the bucket is marked pending.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(learned.agentSamples)
            .sort((a, b) => b[1] - a[1])
            .map(([name, n]) => {
              const level = learned.agentTrust[name] ?? "none";
              const locked = n < learned.minBucketSample;
              const progress = Math.min(1, n / learned.minBucketSample);
              return (
                <div key={name} className="rounded border border-border p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] text-foreground">{name}</span>
                    <span className="font-mono text-[11px] text-foreground">
                      ×{(learned.agentWeights[name] ?? 1).toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-muted">
                    <div
                      className={locked ? "h-full bg-accent" : "h-full bg-emerald-500"}
                      style={{ width: `${progress * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {locked
                      ? `pending — ${n}/${learned.minBucketSample} trades, weight locked`
                      : `${level} trust · ${n} closed trades`}
                  </p>
                </div>
              );
            })}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-3">
        <h3 className="text-xs font-medium text-foreground">Rolling-window edge</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Recent windows vs all time. A short window well below the long one means the edge is
          decaying, not just noisy.
        </p>
        {closedTrades.length === 0 ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            No closed round trips this session yet.
          </p>
        ) : (
          <table className="mt-2 w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-normal">Window</th>
                <th className="py-1 text-right font-normal">N</th>
                <th className="py-1 text-right font-normal">Win</th>
                <th className="py-1 text-right font-normal">Net PnL</th>
                <th className="py-1 text-right font-normal">Exp/trade</th>
                <th className="py-1 text-right font-normal">Fees+funding</th>
                <th className="py-1 text-right font-normal">Cost drag</th>
                <th className="py-1 text-right font-normal">Stability</th>
                <th className="py-1 text-right font-normal">Trust</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((w) => (
                <tr key={w.label} className="border-t border-border/50">
                  <td className="py-1 text-foreground">{w.label}</td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">{w.trades}</td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {pct(w.winRate)}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${w.netPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {usd(w.netPnl)}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${w.expectancy >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {usd(w.expectancy)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {usd(w.fees + w.funding)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">
                    {pct(w.costDrag)}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${w.stability >= 1 ? "text-emerald-400" : w.stability <= -1 ? "text-red-400" : "text-muted-foreground"}`}
                  >
                    {w.stability.toFixed(2)}
                  </td>
                  <td className="py-1 text-right">
                    <span className={`font-mono text-[10px] uppercase ${TRUST_CLASS[w.trust]}`}>
                      {w.trust}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {drift && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            Drift: last {drift.sample} trades {usd(drift.recentExp)}/trade vs prior {drift.sample}{" "}
            at {usd(drift.priorExp)} —{" "}
            <span className={drift.delta >= 0 ? "text-emerald-400" : "text-red-400"}>
              {drift.delta >= 0 ? "improving" : "decaying"} {usd(Math.abs(drift.delta))}/trade
            </span>
            .
          </p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-3">
        <h3 className="text-xs font-medium text-foreground">Live learned parameters</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Derived from {learned.sample} closed trades and applied to the running swarm.
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
          {Object.entries(learned.agentWeights).map(([name, w]) => (
            <span
              key={name}
              className="rounded border border-border px-2 py-1 font-mono text-foreground"
            >
              {name} ×{w.toFixed(2)}
              {(learned.agentSamples[name] ?? 0) < learned.minBucketSample && (
                <span className="ml-1 text-accent">(base)</span>
              )}
            </span>
          ))}
          <span className="rounded border border-border px-2 py-1 font-mono text-foreground">
            minConf {learned.minConfidence.toFixed(2)}
          </span>
          <span className="rounded border border-border px-2 py-1 font-mono text-foreground">
            edge hurdle {learned.requiredEdgeBps.toFixed(1)} bps
          </span>
          <span className="rounded border border-border px-2 py-1 font-mono text-foreground">
            suppressed {learned.suppressedSymbols.length}
          </span>
          <span className="rounded border border-border px-2 py-1 font-mono text-foreground">
            cost-suppressed {learned.costSuppressedSymbols.length}
          </span>
        </div>

        {learned.suppressedSymbols.length > 0 && (
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {learned.suppressedSymbols.slice(0, 24).join(" · ")}
          </p>
        )}
        {learned.costSuppressedSymbols.length > 0 && (
          <p className="mt-1 font-mono text-[10px] text-accent">
            cost drag kills edge: {learned.costSuppressedSymbols.slice(0, 24).join(" · ")}
          </p>
        )}
        {report.execution && report.execution.trades > 0 && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            Stored execution: gross {usd(report.execution.gross_pnl)} → net{" "}
            {usd(report.execution.net_pnl)} after {usd(report.execution.fees)} fees and{" "}
            {usd(report.execution.funding)} funding · {usd(report.execution.slip_cost)}{" "}
            slippage already inside gross (avg round-trip{" "}
            {(
              report.execution.avg_entry_slip_bps + report.execution.avg_exit_slip_bps
            ).toFixed(1)}{" "}
            bps) · {report.execution.liquidations} liquidations.
            {Math.abs(report.execution.residual ?? 0) > 0.01 && (
              <span className="text-bear">
                {" "}
                Unreconciled {usd(report.execution.residual ?? 0)} across{" "}
                {report.execution.unreconciled ?? 0} trade(s).
              </span>
            )}
          </p>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          Ingested: {storedSignals} signals · {storedTrades} trades persisted to your account.
        </p>

      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <EdgeTable
          title="Per-agent edge"
          subtitle="Outcome of trades each agent voted with. Drives agent weights."
          rows={report.agents}
          emptyLabel="No closed trades yet — agent edge appears after the first exits."
        />
        <EdgeTable
          title="Per-symbol edge"
          subtitle="Which perpetuals actually pay. Negative-expectancy names get suppressed."
          rows={report.symbols}
          emptyLabel="No symbol history yet."
        />
        <EdgeTable
          title="Per-regime edge"
          subtitle="Volatility regime at entry time."
          rows={report.regimes}
          emptyLabel="No regime history yet."
        />
        <EdgeTable
          title="Confidence calibration"
          subtitle="Predicted confidence bucket vs realized outcome. Sets the entry threshold."
          rows={report.confidence}
          emptyLabel="No calibration data yet."
        />
        <EdgeTable
          title="Hour-of-day edge (UTC)"
          subtitle="When the swarm wins."
          rows={report.hours}
          emptyLabel="No session history yet."
        />
      </div>
    </div>
  );
}
