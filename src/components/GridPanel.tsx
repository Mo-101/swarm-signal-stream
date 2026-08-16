// Futures grid — the dashboard's view of the control plane.
//
// Read-mostly: the only writes are "configure" and "stop", both of which record
// intent. Nothing here executes a grid; the runner does that. The version pair
// (applied/config) is shown deliberately, because it is the honest signal of
// whether the runner has caught up with what you asked for.
import { useCallback, useEffect, useState } from "react";
import { configureGrid, loadGridStates, stopGrid } from "@/lib/grid.functions";

type GridRow = Awaited<ReturnType<typeof loadGridStates>>[number];

const STATUS_TONE: Record<string, string> = {
  running: "text-bull",
  starting: "text-foreground",
  halted: "text-bear",
  error: "text-bear",
  stopping: "text-muted-foreground",
  idle: "text-muted-foreground",
};

function usd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-sm ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}

export function GridPanel({ defaultSymbol = "BTCUSDT" }: { defaultSymbol?: string }) {
  const [rows, setRows] = useState<GridRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await loadGridStates());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load grids");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function createGrid() {
    setBusy(true);
    setError(null);
    try {
      // Range is derived from nothing here on purpose — a real control needs
      // the user's own bounds. This is a smoke-test button, not a strategy.
      await configureGrid({
        data: {
          symbol: defaultSymbol,
          direction: "neutral",
          lowerPrice: 100_000,
          upperPrice: 110_000,
          gridCount: 20,
          gridType: "arithmetic",
          leverage: 2,
          investmentUsd: 100,
          qtyPerGrid: 0.001,
          economics: {
            makerFeeRate: 0.0002,
            takerFeeRate: 0.00055,
            estimatedSlippageBps: 1,
            expectedFundingRate: 0,
            minimumNetEdgeBps: 5,
          },
          risk: {
            maxLeverage: 3,
            minLiquidationDistancePct: 0.15,
            maxMarginUtilizationPct: 0.5,
            minFreeMarginPct: 0.3,
            maxOpenGridOrders: 20,
            maxPositionNotionalUsd: 200,
          },
        },
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to configure grid");
    } finally {
      setBusy(false);
    }
  }

  async function halt(symbol: string) {
    setBusy(true);
    setError(null);
    try {
      await stopGrid({ data: { symbol } });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop grid");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Futures Grid</h2>
          <p className="text-[11px] text-muted-foreground">
            Dashboard writes intent · the runner owns execution
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void createGrid()}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {busy ? "Working…" : `Create Paper Grid (${defaultSymbol})`}
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-bear/40 bg-bear/10 p-2 text-xs text-bear">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">No grid configured.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map((row) => {
            const s = row.runtimeState;
            const synced = row.appliedVersion === row.configVersion;
            return (
              <div key={row.id} className="rounded-lg border border-border bg-background/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm">{row.symbol}</span>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs ${STATUS_TONE[row.runtimeStatus] ?? ""}`}>
                      {row.runtimeStatus}
                    </span>
                    {row.desiredState === "running" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void halt(row.symbol)}
                        className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50"
                      >
                        Stop
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Desired" value={row.desiredState} />
                  <Field
                    label="Version"
                    value={`${row.appliedVersion}/${row.configVersion}`}
                    tone={synced ? "text-foreground" : "text-bear"}
                  />
                  <Field label="Mark" value={s?.markPrice != null ? String(s.markPrice) : "—"} />
                  <Field label="Position" value={String(s?.positionQty ?? 0)} />
                  <Field
                    label="Unrealized"
                    value={usd(s?.unrealizedPnlUsd ?? 0)}
                    tone={(s?.unrealizedPnlUsd ?? 0) < 0 ? "text-bear" : "text-bull"}
                  />
                  <Field label="Grid profit" value={usd(s?.gridProfitUsd ?? 0)} />
                  <Field label="Funding" value={usd(s?.fundingUsd ?? 0)} />
                  <Field
                    label="Orders"
                    value={s ? `${s.buyOrders} buy / ${s.sellOrders} sell` : "—"}
                  />
                </div>

                {s?.haltReasons?.length ? (
                  <div className="mt-2 text-[11px] text-bear">
                    Halted: {s.haltReasons.join(", ")}
                  </div>
                ) : null}

                {row.lastError && (
                  <div className="mt-2 text-[11px] text-bear">Error: {row.lastError}</div>
                )}

                {!synced && !row.lastError && (
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    Waiting for the runner to apply version {row.configVersion}…
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
