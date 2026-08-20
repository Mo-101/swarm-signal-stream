// Per-decision edge diagnostics: how the swarm reached consensus, how much
// dissent damped the conviction, the expected move it priced, and the exact
// cost hurdle that move had to clear.
import { useMemo } from "react";
import { ROUND_TRIP_FEE_BPS, type EdgeReport, type LearnedEdge } from "@/lib/edge-model";
import type { TradeProposal } from "@/lib/swarm";

function bps(v: number) {
  return `${v.toFixed(1)}`;
}

export interface HurdleParts {
  feeBps: number;
  entrySlipBps: number;
  exitSlipBps: number;
  spreadBps: number;
  totalCostBps: number;
  marginMultiple: number;
  requiredEdgeBps: number;
  measured: boolean;
}

/** Break the learned hurdle back into the components that produced it. */
export function hurdleComponents(report: EdgeReport, learned: LearnedEdge): HurdleParts {
  const exec = report.execution;
  const measured = Boolean(exec && exec.trades >= 3);
  const entrySlipBps = measured ? (exec?.avg_entry_slip_bps ?? 0) : 0;
  const exitSlipBps = measured ? (exec?.avg_exit_slip_bps ?? 0) : 0;
  const totalCostBps = ROUND_TRIP_FEE_BPS + entrySlipBps + exitSlipBps;
  return {
    feeBps: ROUND_TRIP_FEE_BPS,
    entrySlipBps,
    exitSlipBps,
    // Spread is paid inside the slip measurement; shown for context only.
    spreadBps: measured ? entrySlipBps + exitSlipBps : 0,
    totalCostBps,
    marginMultiple: 1.5,
    requiredEdgeBps: learned.requiredEdgeBps,
    measured,
  };
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function EdgeDiagnosticsPanel({
  proposals,
  report,
  learned,
}: {
  proposals: TradeProposal[];
  report: EdgeReport;
  learned: LearnedEdge;
}) {
  const hurdle = useMemo(() => hurdleComponents(report, learned), [report, learned]);
  const rows = useMemo(() => proposals.slice(0, 60), [proposals]);

  const diagnosed = rows.filter((p) => p.consensus !== undefined);
  const avgConsensus =
    diagnosed.length > 0
      ? diagnosed.reduce((a, p) => a + (p.consensus ?? 1), 0) / diagnosed.length
      : 0;
  const contested = diagnosed.filter((p) => (p.dissent ?? 0) > 0).length;
  const clearing = diagnosed.filter(
    (p) => (p.expectedMoveBps ?? 0) >= hurdle.requiredEdgeBps,
  ).length;

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Avg consensus ratio"
          value={diagnosed.length ? `${(avgConsensus * 100).toFixed(1)}%` : "—"}
          hint={`${diagnosed.length} recent decisions`}
        />
        <Stat
          label="Contested decisions"
          value={diagnosed.length ? `${contested} / ${diagnosed.length}` : "—"}
          hint="at least one agent voting the other way"
        />
        <Stat
          label="Cost hurdle"
          value={`${bps(hurdle.requiredEdgeBps)} bps`}
          hint={hurdle.measured ? "from measured fills" : "fee-only (needs 3+ closed trades)"}
        />
        <Stat
          label="Clearing the hurdle"
          value={diagnosed.length ? `${clearing} / ${diagnosed.length}` : "—"}
          hint="expected move ≥ required edge"
        />
      </div>

      <section className="rounded-lg border border-border bg-card p-3">
        <h3 className="text-xs font-medium text-foreground">Cost hurdle components</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Every entry must out-earn the round trip. The hurdle is the measured cost of doing
          business times a {hurdle.marginMultiple}× safety margin.
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
          {[
            { k: "taker fees (2 legs)", v: `${bps(hurdle.feeBps)} bps` },
            { k: "avg entry slip", v: `${bps(hurdle.entrySlipBps)} bps` },
            { k: "avg exit slip", v: `${bps(hurdle.exitSlipBps)} bps` },
            { k: "= total cost", v: `${bps(hurdle.totalCostBps)} bps` },
            { k: `× margin`, v: `${hurdle.marginMultiple.toFixed(1)}×` },
            { k: "= required edge", v: `${bps(hurdle.requiredEdgeBps)} bps` },
            { k: "min confidence", v: learned.minConfidence.toFixed(2) },
          ].map((c) => (
            <span
              key={c.k}
              className="rounded border border-border px-2 py-1 font-mono text-foreground"
            >
              {c.k} {c.v}
            </span>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-3">
        <h3 className="text-xs font-medium text-foreground">Per-decision breakdown</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Raw conviction is the weighted vote of the agreeing agents; dissent is subtracted from it
          to give the confidence the broker actually sees.
        </p>
        {rows.length === 0 ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            No signals yet — diagnostics appear with the first consensus proposal.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-normal">Symbol</th>
                  <th className="py-1 text-left font-normal">Side</th>
                  <th className="py-1 text-right font-normal">Agree/Dissent</th>
                  <th className="py-1 text-right font-normal">Consensus</th>
                  <th className="py-1 text-right font-normal">Raw</th>
                  <th className="py-1 text-right font-normal">Damp</th>
                  <th className="py-1 text-right font-normal">Final</th>
                  <th className="py-1 text-right font-normal">Vol (bps)</th>
                  <th className="py-1 text-right font-normal">Exp move</th>
                  <th className="py-1 text-right font-normal">Hurdle</th>
                  <th className="py-1 text-right font-normal">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const raw = p.rawConfidence ?? p.confidence;
                  const damp = raw > 0 ? 1 - p.confidence / raw : 0;
                  const exp = p.expectedMoveBps ?? 0;
                  const clears = exp >= hurdle.requiredEdgeBps;
                  const conf = p.confidence >= learned.minConfidence;
                  return (
                    <tr key={p.id} className="border-t border-border/50">
                      <td className="py-1 font-mono text-foreground">{p.symbol}</td>
                      <td
                        className={`py-1 font-mono ${p.direction === "BUY" ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {p.direction}
                      </td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {p.agreement ?? "—"} / {p.dissent ?? "—"}
                      </td>
                      <td className="py-1 text-right tabular-nums text-foreground">
                        {p.consensus !== undefined ? `${(p.consensus * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {raw.toFixed(2)}
                      </td>
                      <td
                        className={`py-1 text-right tabular-nums ${damp > 0 ? "text-accent" : "text-muted-foreground"}`}
                      >
                        −{(damp * 100).toFixed(0)}%
                      </td>
                      <td className="py-1 text-right tabular-nums text-foreground">
                        {p.confidence.toFixed(2)}
                      </td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {p.volBps !== undefined ? bps(p.volBps) : "—"}
                      </td>
                      <td className="py-1 text-right tabular-nums text-foreground">
                        {p.expectedMoveBps !== undefined ? bps(exp) : "—"}
                      </td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {bps(hurdle.requiredEdgeBps)}
                      </td>
                      <td
                        className={`py-1 text-right font-mono text-[10px] uppercase ${clears && conf ? "text-emerald-400" : "text-muted-foreground"}`}
                      >
                        {!conf ? "low conf" : clears ? "clears" : "under hurdle"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
