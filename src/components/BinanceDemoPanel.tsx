import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  getBinanceDemoSummary,
  setBinanceDemoArmed,
  type BinanceDemoSummary,
} from "@/lib/binance-demo.functions";

function bps(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(1)} bps`;
}
function time(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleTimeString([], { hour12: false });
}

const STATUS_COLOR: Record<string, string> = {
  filled: "text-emerald-400",
  rejected: "text-red-400",
  pending: "text-amber-400",
  cancelled: "text-muted-foreground",
};

/**
 * Read-only view of the runner's Binance demo (testnet) mirror plus the
 * kill switch. Nothing here submits an order — the VPS runner does, and it
 * stops within one control poll of being disarmed.
 */
export function BinanceDemoPanel() {
  const fetchSummary = useServerFn(getBinanceDemoSummary);
  const setArmed = useServerFn(setBinanceDemoArmed);
  const [data, setData] = useState<BinanceDemoSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchSummary());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetchSummary]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const toggle = async () => {
    if (!data) return;
    const next = !data.armed;
    setBusy(true);
    try {
      await setArmed({ data: { armed: next, reason: next ? undefined : "kill switch" } });
      toast[next ? "success" : "warning"](
        next ? "Binance demo armed" : "Binance demo disarmed — runner stops within 15s",
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change arm state");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-3">
        <div>
          <div className="text-sm font-medium">
            Binance demo mirror{" "}
            <span className={data?.armed ? "text-emerald-400" : "text-muted-foreground"}>
              {data ? (data.armed ? "· ARMED" : "· disarmed") : "· loading"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            v3 paper fills are mirrored to Binance Futures testnet by the VPS runner. Testnet
            tokens only — paper trading is unaffected either way.
          </p>
          {data?.disarmReason && !data.armed && (
            <p className="mt-1 text-xs text-amber-400">Reason: {data.disarmReason}</p>
          )}
        </div>
        <button
          type="button"
          disabled={busy || !data}
          onClick={() => void toggle()}
          className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
            data?.armed
              ? "bg-red-500/15 text-red-400 hover:bg-red-500/25"
              : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
          }`}
        >
          {data?.armed ? "Disarm (kill switch)" : "Arm demo routing"}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-400">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          ["Orders", String(data?.orders ?? 0)],
          ["Fills", String(data?.fills ?? 0)],
          ["Rejects", String(data?.rejects ?? 0)],
          ["Avg slip vs paper", bps(data?.avgSlippageBps ?? null)],
          ["Worst slip", bps(data?.worstSlippageBps ?? null)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border border-border bg-background/40 p-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-0.5 font-mono text-sm">{value}</div>
          </div>
        ))}
      </div>

      {data && data.bySymbol.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Live-vs-paper fill gap by symbol
          </div>
          <div className="flex flex-wrap gap-2">
            {data.bySymbol.map((s) => (
              <span
                key={s.symbol}
                className="rounded border border-border bg-background/40 px-2 py-1 font-mono text-[11px]"
              >
                {s.symbol} {bps(s.avgSlippageBps)} <span className="opacity-60">n={s.fills}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Time</th>
              <th className="py-1 pr-3 font-medium">Symbol</th>
              <th className="py-1 pr-3 font-medium">Side</th>
              <th className="py-1 pr-3 font-medium">Phase</th>
              <th className="py-1 pr-3 font-medium">Type</th>
              <th className="py-1 pr-3 text-right font-medium">Paper</th>
              <th className="py-1 pr-3 text-right font-medium">Fill</th>
              <th className="py-1 pr-3 text-right font-medium">Gap</th>
              <th className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {(data?.recent ?? []).map((r, i) => (
              <tr key={`${r.tradeId}-${r.phase}-${i}`} className="border-t border-border/50">
                <td className="py-1 pr-3">{time(r.createdAt)}</td>
                <td className="py-1 pr-3">{r.symbol}</td>
                <td className={`py-1 pr-3 ${r.side === "BUY" ? "text-emerald-400" : "text-red-400"}`}>
                  {r.side}
                </td>
                <td className="py-1 pr-3">{r.phase}</td>
                <td className="py-1 pr-3">{r.orderType}</td>
                <td className="py-1 pr-3 text-right">{r.paperPrice ?? "—"}</td>
                <td className="py-1 pr-3 text-right">{r.fillPrice ?? "—"}</td>
                <td className="py-1 pr-3 text-right">{bps(r.slippageBps)}</td>
                <td className={`py-1 ${STATUS_COLOR[r.status] ?? ""}`} title={r.error ?? undefined}>
                  {r.status}
                  {r.error ? " ⚠" : ""}
                </td>
              </tr>
            ))}
            {(!data || data.recent.length === 0) && (
              <tr>
                <td colSpan={9} className="py-4 text-center text-muted-foreground">
                  No demo orders yet — arm routing and set BINANCE_DEMO_ENABLED=true on the runner.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
