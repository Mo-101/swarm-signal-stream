import { winRate, type EdgeReport, type EdgeRow, type LearnedEdge } from "@/lib/edge-model";

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}
function usd(v: number) {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
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
}: {
  report: EdgeReport;
  learned: LearnedEdge;
  storedSignals: number;
  storedTrades: number;
  persistError: string | null;
}) {
  const t = report.totals;
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
            </span>
          ))}
          <span className="rounded border border-border px-2 py-1 font-mono text-foreground">
            minConf {learned.minConfidence.toFixed(2)}
          </span>
          <span className="rounded border border-border px-2 py-1 font-mono text-foreground">
            suppressed {learned.suppressedSymbols.length}
          </span>
        </div>
        {learned.suppressedSymbols.length > 0 && (
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {learned.suppressedSymbols.slice(0, 24).join(" · ")}
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
