import type {
  ExecutionStats,
  PendingOrder,
  RejectRecord,
  ClosedTrade,
  RiskAlert,
} from "@/lib/paper-broker";
import type { MicroMetrics } from "@/lib/microstructure";

function bps(v: number): string {
  return `${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(1)} bps`;
}
function usd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

const REJECT_LABELS: Record<string, string> = {
  "no-book": "No live depth",
  "stale-book": "Stale book",
  "thin-book": "Book too thin",
  "min-qty": "Below min lot",
  "min-notional": "Below min notional",
  margin: "Insufficient margin",
  slippage: "Slippage over cap",
  "signal-stale": "Price moved in flight",
  duplicate: "Duplicate order",
  halted: "Risk halt",
  "max-positions": "No free slot",
  confidence: "Below confidence",
  "no-filter": "No instrument filters",
  cooldown: "Symbol cooling off",
  "side-cap": "Same-side cap hit",
  "cost-gate": "Cost exceeds edge",
  "passive-expired": "Post-only never filled",
};

export function ExecutionPanel({
  stats,
  micro,
  pending,
  rejects,
  closed,
  riskAlerts = [],
}: {
  stats: ExecutionStats;
  micro: MicroMetrics | null;
  pending: PendingOrder[];
  rejects: RejectRecord[];
  closed: ClosedTrade[];
  riskAlerts?: RiskAlert[];
}) {
  const attempted = stats.filled + stats.rejected;
  const fillRate = attempted ? (stats.filled / attempted) * 100 : 0;
  const roundTripBps = stats.avgEntrySlipBps + stats.avgExitSlipBps;
  const bookShare = stats.filled ? (stats.bookPricedFills / stats.filled) * 100 : 0;

  const slipDrag = closed.reduce((a, t) => a + t.slipCostUsd, 0);
  const grossSum = closed.reduce((a, t) => a + t.grossPnl, 0);

  return (
    <div className="space-y-3 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="Fill rate"
          value={`${fillRate.toFixed(0)}%`}
          sub={`${stats.filled} filled · ${stats.rejected} rejected · ${stats.pending} in flight`}
          tone={fillRate >= 60 ? "bull" : fillRate >= 30 ? "neutral" : "bear"}
        />
        <Card
          title="Round-trip slippage"
          value={bps(roundTripBps)}
          sub={`entry ${bps(stats.avgEntrySlipBps)} · exit ${bps(stats.avgExitSlipBps)}`}
          tone={roundTripBps <= 6 ? "bull" : roundTripBps <= 15 ? "neutral" : "bear"}
        />
        <Card
          title="Slippage cost"
          value={usd(stats.slipCostUsd)}
          sub={
            grossSum !== 0
              ? `${((slipDrag / Math.abs(grossSum)) * 100).toFixed(1)}% of gross PnL`
              : "spread + market impact paid"
          }
          tone={stats.slipCostUsd > 0 ? "bear" : "neutral"}
        />
        <Card
          title="Fill latency"
          value={`${stats.avgFillLatencyMs.toFixed(0)} ms`}
          sub={`avg fill ratio ${(stats.avgFillRatio * 100).toFixed(0)}% · ${stats.partialFills} partial`}
          tone="neutral"
        />
        <Card
          title="Book coverage"
          value={`${bookShare.toFixed(0)}%`}
          sub={`${stats.bookPricedFills} L2-priced · ${stats.modelPricedFills} modelled`}
          tone={bookShare >= 90 ? "bull" : bookShare >= 50 ? "neutral" : "bear"}
        />
        <Card
          title="Depth feed"
          value={micro?.connected ? "connected" : "offline"}
          sub={`${micro?.books ?? 0}/${micro?.tracked ?? 0} live books · ${micro?.filters ?? 0} instruments`}
          tone={micro?.connected ? "bull" : "bear"}
        />
        <Card
          title="Avg spread"
          value={bps(micro?.avgSpreadBps ?? 0)}
          sub={`fills crossed ${bps(stats.avgSpreadBps)} avg`}
          tone={(micro?.avgSpreadBps ?? 0) <= 5 ? "bull" : "neutral"}
        />
        <Card
          title="Worst slip"
          value={bps(stats.worstSlipBps)}
          sub={`${micro?.snapshots ?? 0} snapshots · ${micro?.resyncs ?? 0} resyncs`}
          tone={stats.worstSlipBps > 30 ? "bear" : "neutral"}
        />
      </div>
      <SlippageControl stats={stats} />

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-lg border border-border">
          <Header
            title="Orders in flight"
            subtitle="Signals waiting out simulated exchange latency"
          />
          {pending.length === 0 ? (
            <Empty label="No orders in flight." />
          ) : (
            <ul className="divide-y divide-border">
              {pending.map((o) => (
                <li key={o.id} className="flex items-center justify-between px-4 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                        o.side === "BUY" ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
                      }`}
                    >
                      {o.side}
                    </span>
                    <span className="font-mono text-xs">{o.symbol}</span>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    fills in {Math.max(0, o.readyAt - Date.now())}ms
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-border">
          <Header
            title="Rejected orders"
            subtitle="Why the simulated exchange refused the fill"
          />
          {Object.keys(stats.rejectsByReason).length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2">
              {Object.entries(stats.rejectsByReason)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, n]) => (
                  <span
                    key={reason}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {REJECT_LABELS[reason] ?? reason} · {n}
                  </span>
                ))}
            </div>
          )}
          {rejects.length === 0 ? (
            <Empty label="No rejections yet." />
          ) : (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto">
              {rejects.slice(0, 25).map((r) => (
                <li key={r.id + r.at} className="px-4 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xs">{r.symbol}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {time(r.at)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    <span className="text-accent">{REJECT_LABELS[r.reason] ?? r.reason}</span>
                    {" — "}
                    {r.detail}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-lg border border-border">
        <Header
          title="Portfolio risk limits"
          subtitle="Trades the mandate refused — slot cap, same-direction exposure, cooldown, drawdown halt"
        />
        {riskAlerts.length === 0 ? (
          <Empty label="No risk limits hit. The swarm has had every slot it asked for." />
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto">
            {riskAlerts.slice(0, 25).map((a) => (
              <li key={a.id + a.at} className="px-4 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs">
                    <span className={a.side === "BUY" ? "text-bull" : "text-bear"}>{a.side}</span>{" "}
                    {a.symbol}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">{time(a.at)}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  <span className="text-accent">{REJECT_LABELS[a.limit] ?? a.limit}</span>
                  {" — "}
                  {a.detail}
                  <span className="ml-1 opacity-70">
                    (open {a.openPositions} · same-side {a.sameSide})
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>


      <section className="rounded-lg border border-border">
        <Header
          title="Fill quality by trade"
          subtitle="Signal price vs actual fill, and what the round trip cost"
        />
        {closed.length === 0 ? (
          <Empty label="No completed round trips yet." />
        ) : (
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 text-left font-medium">Symbol</th>
                  <th className="px-4 py-2 text-right font-medium">Signal → Fill</th>
                  <th className="px-4 py-2 text-right font-medium">Entry slip</th>
                  <th className="px-4 py-2 text-right font-medium">Trigger → Exit</th>
                  <th className="px-4 py-2 text-right font-medium">Exit slip</th>
                  <th className="px-4 py-2 text-right font-medium">Latency</th>
                  <th className="px-4 py-2 text-right font-medium">Slip cost</th>
                  <th className="px-4 py-2 text-right font-medium">Gross → Net</th>
                </tr>
              </thead>
              <tbody>
                {closed.slice(0, 40).map((t) => (
                  <tr key={t.id + t.closedAt} className="border-b border-border/50">
                    <td className="px-4 py-1.5 font-mono text-xs">{t.symbol}</td>
                    <td className="px-4 py-1.5 text-right font-mono text-[11px] tabular text-muted-foreground">
                      {t.signalPrice.toPrecision(6)} → {t.entryPrice.toPrecision(6)}
                    </td>
                    <td
                      className={`px-4 py-1.5 text-right font-mono text-[11px] tabular ${
                        t.entrySlipBps > 0 ? "text-bear" : "text-bull"
                      }`}
                    >
                      {bps(t.entrySlipBps)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-[11px] tabular text-muted-foreground">
                      {t.triggerPrice.toPrecision(6)} → {t.exitPrice.toPrecision(6)}
                    </td>
                    <td
                      className={`px-4 py-1.5 text-right font-mono text-[11px] tabular ${
                        t.exitSlipBps > 0 ? "text-bear" : "text-bull"
                      }`}
                    >
                      {bps(t.exitSlipBps)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-[11px] tabular text-muted-foreground">
                      {t.latencyMs.toFixed(0)}ms
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-[11px] tabular text-bear">
                      {usd(t.slipCostUsd)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-[11px] tabular">
                      <span className={t.grossPnl >= 0 ? "text-bull" : "text-bear"}>
                        {usd(t.grossPnl)}
                      </span>
                      {" → "}
                      <span className={t.pnl >= 0 ? "text-bull" : "text-bear"}>{usd(t.pnl)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}


function AlphaVsFills({ closed, stats }: { closed: ClosedTrade[]; stats: ExecutionStats }) {
  const n = closed.length;
  const gross = closed.reduce((a, t) => a + t.grossPnl, 0);
  const net = closed.reduce((a, t) => a + t.pnl, 0);
  const fees = closed.reduce((a, t) => a + t.fees, 0);
  const funding = closed.reduce((a, t) => a + t.funding, 0);
  const slip = closed.reduce((a, t) => a + t.slipCostUsd, 0);
  const cost = fees + funding + slip;
  const share = (v: number) => (gross !== 0 ? Math.min(100, (Math.abs(v) / Math.abs(gross)) * 100) : 0);
  const avgLatency = n ? closed.reduce((a, t) => a + t.latencyMs, 0) / n : 0;
  const bookShare = n ? (closed.filter((t) => t.bookPriced).length / n) * 100 : 0;
  const verdict =
    n === 0
      ? "No closed round trips yet."
      : gross <= 0 && net > 0
        ? "Profit is coming from fills, not alpha — the signal loses at mid price."
        : gross > 0 && net <= 0
          ? "Alpha is real but execution eats all of it — costs exceed the raw edge."
          : gross > 0 && cost / Math.abs(gross) > 0.5
            ? "Alpha-driven, but over half of the raw edge is lost to fills."
            : gross > 0
              ? "Alpha-driven: raw signal edge survives execution cost."
              : "Both raw edge and net result are negative.";

  return (
    <section className="rounded-lg border border-border">
      <Header
        title="Alpha vs fills"
        subtitle="Signal edge at mid price versus what the fills actually cost"
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="Gross (alpha)"
          value={usd(gross)}
          sub={`${n} round trips at signal-to-trigger prices`}
          tone={gross >= 0 ? "bull" : "bear"}
        />
        <Card
          title="Execution cost"
          value={usd(-cost)}
          sub={`fees ${usd(fees)} · funding ${usd(funding)} · slip ${usd(slip)}`}
          tone={cost > 0 ? "bear" : "neutral"}
        />
        <Card
          title="Net realized"
          value={usd(net)}
          sub={gross !== 0 ? `${((net / Math.abs(gross)) * 100).toFixed(0)}% of gross retained` : "—"}
          tone={net >= 0 ? "bull" : "bear"}
        />
        <Card
          title="Trigger → fill"
          value={`${avgLatency.toFixed(0)} ms`}
          sub={`entry ${bps(stats.avgEntrySlipBps)} · exit ${bps(stats.avgExitSlipBps)} · ${bookShare.toFixed(0)}% book-priced`}
          tone={avgLatency <= 400 ? "bull" : "neutral"}
        />
      </div>
      <div className="space-y-2 px-4 pb-4">
        {[
          { label: "Fees", value: fees, className: "bg-bear/60" },
          { label: "Funding", value: funding, className: "bg-accent/60" },
          { label: "Slippage", value: slip, className: "bg-bear/40" },
        ].map((row) => (
          <div key={row.label} className="flex items-center gap-3">
            <span className="w-20 text-[11px] text-muted-foreground">{row.label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
              <div className={`h-full ${row.className}`} style={{ width: `${share(row.value)}%` }} />
            </div>
            <span className="w-28 text-right font-mono text-[11px] tabular text-muted-foreground">
              {usd(row.value)} · {share(row.value).toFixed(0)}% of gross
            </span>
          </div>
        ))}
        <p className="pt-1 text-[11px] text-muted-foreground">{verdict}</p>
      </div>
    </section>
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

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-border px-4 py-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="px-4 py-10 text-center text-xs text-muted-foreground">{label}</div>
  );
}
