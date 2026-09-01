// Counterfactual shadow book — what the swarm gave up by NOT trading.
import type { ShadowStats } from "@/lib/shadow-book";

function usd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "bull" | "bear";
}) {
  const color =
    tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function ShadowPanel({
  shadow,
  currentThreshold,
}: {
  shadow: ShadowStats;
  currentThreshold: number;
}) {
  const tone = shadow.totalNetUsd > 0 ? "bear" : "bull"; // profitable skips = bad gate
  const rec = shadow.recommendedThreshold;

  return (
    <div className="space-y-4 p-3">
      <div>
        <h2 className="text-sm font-semibold">Shadow book — counterfactual</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every proposal the engine declined is opened here as a zero-risk virtual position on a
          fixed {usd(shadow.notional)} notional, marked on the same live ticks, with the same
          stop/target and both taker fees charged. It answers one question the real book cannot:
          is the gate protecting capital, or leaving money on the table?
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Skipped PnL"
          value={usd(shadow.totalNetUsd)}
          hint={shadow.totalNetUsd > 0 ? "gate cost us this" : "gate saved us this"}
          tone={tone}
        />
        <Stat
          label="Shadow expectancy"
          value={`${shadow.expectancyBps.toFixed(1)} bps`}
          hint={`${shadow.closedCount} closed · ${shadow.openCount} open`}
          tone={shadow.expectancyBps > 0 ? "bear" : "bull"}
        />
        <Stat
          label="Shadow win rate"
          value={`${shadow.winRate.toFixed(1)}%`}
          hint="of declined trades that would have won"
        />
        <Stat
          label="Suggested gate"
          value={rec === null ? "—" : rec.toFixed(2)}
          hint={
            rec === null
              ? `${shadow.samplesToTrust} more samples needed`
              : rec > currentThreshold
                ? `raise from ${currentThreshold.toFixed(2)}`
                : rec < currentThreshold
                  ? `lower from ${currentThreshold.toFixed(2)}`
                  : "current gate is optimal"
          }
          tone={rec !== null && rec !== currentThreshold ? "bear" : "bull"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-medium">
            Why they were skipped
          </div>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-1.5 text-left font-medium">Reason</th>
                <th className="px-3 py-1.5 text-right font-medium">Open</th>
                <th className="px-3 py-1.5 text-right font-medium">Closed</th>
                <th className="px-3 py-1.5 text-right font-medium">Win %</th>
                <th className="px-3 py-1.5 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {shadow.byReason.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    No declined proposals yet.
                  </td>
                </tr>
              )}
              {shadow.byReason.map((b) => (
                <tr key={b.key} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-1.5">{b.key}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{b.open}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{b.closed}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{b.winRate.toFixed(0)}%</td>
                  <td
                    className={`px-3 py-1.5 text-right font-mono ${b.netUsd > 0 ? "text-bear" : "text-bull"}`}
                  >
                    {usd(b.netUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-medium">
            Confidence gate sweep (real + shadow)
          </div>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-1.5 text-left font-medium">Gate</th>
                <th className="px-3 py-1.5 text-right font-medium">Trades</th>
                <th className="px-3 py-1.5 text-right font-medium">Win %</th>
                <th className="px-3 py-1.5 text-right font-medium">Exp.</th>
                <th className="px-3 py-1.5 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {shadow.sweep.map((r) => {
                const isCurrent = Math.abs(r.threshold - currentThreshold) < 0.025;
                const isBest = rec !== null && r.threshold === rec;
                return (
                  <tr
                    key={r.threshold}
                    className={`border-b border-border/50 last:border-0 ${isBest ? "bg-primary/10" : ""}`}
                  >
                    <td className="px-3 py-1.5 font-mono">
                      {r.threshold.toFixed(2)}
                      {isCurrent && (
                        <span className="ml-1 text-[10px] text-muted-foreground">now</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{r.trades}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{r.winRate.toFixed(0)}%</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {r.expectancyBps.toFixed(1)}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono ${r.netUsd >= 0 ? "text-bull" : "text-bear"}`}
                    >
                      {usd(r.netUsd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
            Normalised to {usd(shadow.notional)} per trade so real and shadow rows compare
            like-for-like. Advisory only — nothing here changes the live gate.
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-medium">
          By confidence band
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 text-left font-medium">Band</th>
              <th className="px-3 py-1.5 text-right font-medium">Open</th>
              <th className="px-3 py-1.5 text-right font-medium">Closed</th>
              <th className="px-3 py-1.5 text-right font-medium">Win %</th>
              <th className="px-3 py-1.5 text-right font-medium">Exp. bps</th>
              <th className="px-3 py-1.5 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {shadow.byConfidence.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  Waiting for declined proposals.
                </td>
              </tr>
            )}
            {shadow.byConfidence.map((b) => (
              <tr key={b.key} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-1.5 font-mono">{b.key}</td>
                <td className="px-3 py-1.5 text-right font-mono">{b.open}</td>
                <td className="px-3 py-1.5 text-right font-mono">{b.closed}</td>
                <td className="px-3 py-1.5 text-right font-mono">{b.winRate.toFixed(0)}%</td>
                <td className="px-3 py-1.5 text-right font-mono">{b.expectancyBps.toFixed(1)}</td>
                <td
                  className={`px-3 py-1.5 text-right font-mono ${b.netUsd > 0 ? "text-bear" : "text-bull"}`}
                >
                  {usd(b.netUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
