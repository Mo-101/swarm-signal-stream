// Futures grid — the dashboard's view of the control plane.
//
// Read-mostly: the only writes are "configure" and "stop", both of which record
// intent. Nothing here executes a grid; the runner does that. The version pair
// (applied/config) is shown deliberately, because it is the honest signal of
// whether the runner has caught up with what you asked for.
//
// Bounds are derived from the live mark rather than typed in, so a grid always
// brackets the market. The runner re-checks L < M < U against its own mark
// before configuring — this form is convenience, not the safety boundary.
import { useCallback, useEffect, useMemo, useState } from "react";
import { configureGrid, loadGridStates, stopGrid } from "@/lib/grid.functions";
import { deriveRangeFromMark } from "@/lib/futures-grid";

type GridRow = Awaited<ReturnType<typeof loadGridStates>>[number];

export interface GridFormValues {
  symbol: string;
  rangePct: number;
  gridCount: number;
  leverage: number;
  investmentUsd: number;
  qtyPerGrid: number;
  gridType: "arithmetic" | "geometric";
}

const DEFAULTS: GridFormValues = {
  symbol: "BTCUSDT",
  rangePct: 0.05,
  gridCount: 20,
  leverage: 2,
  investmentUsd: 100,
  qtyPerGrid: 0.001,
  gridType: "arithmetic",
};

const STATUS_TONE: Record<string, string> = {
  running: "text-bull",
  starting: "text-foreground",
  halted: "text-bear",
  error: "text-bear",
  stopping: "text-muted-foreground",
  idle: "text-muted-foreground",
};

function usd(v: number): string {
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
}

/**
 * A failing server function rejects with the response body, and this app's SSR
 * wrapper answers 500s with a rendered HTML error page — so the raw message can
 * be an entire document. Dumping that into the panel is unreadable noise, and
 * it buries the one fact worth showing.
 */
function toMessage(e: unknown, fallback: string): string {
  const raw = (e instanceof Error ? e.message : typeof e === "string" ? e : "").trim();
  if (!raw) return fallback;
  if (/^<!doctype|^<html|<body[\s>]|<\/html>/i.test(raw)) {
    return `${fallback} — the server returned an error page. Check the runner logs.`;
  }
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

function num(v: number, dp = 2): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: dp });
}

function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-sm ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  value: number | string;
  onChange: (v: string) => void;
  step?: string;
  min?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <input
        value={value}
        step={step}
        min={min}
        type={typeof value === "number" ? "number" : "text"}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
      />
    </label>
  );
}

export function GridPanel({ marks }: { marks?: Map<string, number> }) {
  const [rows, setRows] = useState<GridRow[]>([]);
  const [form, setForm] = useState<GridFormValues>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  // `sticky` marks an error the user caused (configure/stop). Polling clears a
  // stale load failure once it recovers, but must not wipe an action's error
  // out from under the user two seconds after they caused it.
  const [error, setError] = useState<{ message: string; sticky: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await loadGridStates());
      setError((prev) => (prev?.sticky ? prev : null));
    } catch (e) {
      setError((prev) =>
        prev?.sticky ? prev : { message: toMessage(e, "Failed to load grids"), sticky: false },
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const symbol = form.symbol.trim().toUpperCase();

  // Prefer the live board; fall back to a running grid's last marked price so
  // the form still works on a tab opened before the feed warms up.
  const markPrice = useMemo(() => {
    const live = marks?.get(symbol);
    if (live && Number.isFinite(live) && live > 0) return live;
    const fromGrid = rows.find((r) => r.symbol === symbol)?.runtimeState?.markPrice;
    return fromGrid && Number.isFinite(fromGrid) && fromGrid > 0 ? fromGrid : null;
  }, [marks, symbol, rows]);

  const preview = useMemo(() => {
    if (!markPrice) return null;
    try {
      const { lowerPrice, upperPrice } = deriveRangeFromMark({
        markPrice,
        rangePct: form.rangePct,
      });
      const step = (upperPrice - lowerPrice) / form.gridCount;
      // Levels strictly below the mark become Buys; the rest Sells.
      const buys = Math.max(
        0,
        Math.min(form.gridCount, Math.floor((markPrice - lowerPrice) / step)),
      );
      return { lowerPrice, upperPrice, step, buys, sells: form.gridCount - buys };
    } catch {
      return null;
    }
  }, [markPrice, form.rangePct, form.gridCount]);

  function set<K extends keyof GridFormValues>(key: K, raw: string) {
    setForm((f) => ({
      ...f,
      [key]: typeof DEFAULTS[key] === "number" ? Number(raw) : (raw as GridFormValues[K]),
    }));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      if (!markPrice) throw new Error(`No live mark price for ${symbol} yet`);

      const { lowerPrice, upperPrice } = deriveRangeFromMark({
        markPrice,
        rangePct: form.rangePct,
      });

      await configureGrid({
        data: {
          symbol,
          direction: "long",
          lowerPrice,
          upperPrice,
          gridCount: form.gridCount,
          gridType: form.gridType,
          leverage: form.leverage,
          investmentUsd: form.investmentUsd,
          qtyPerGrid: form.qtyPerGrid,
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
            maxOpenGridOrders: form.gridCount,
            maxPositionNotionalUsd: form.investmentUsd * form.leverage,
          },
        },
      });
      await refresh();
    } catch (e) {
      setError({ message: toMessage(e, "Failed to configure grid"), sticky: true });
    } finally {
      setBusy(false);
    }
  }

  async function halt(sym: string) {
    setBusy(true);
    setError(null);
    try {
      await stopGrid({ data: { symbol: sym } });
      await refresh();
    } catch (e) {
      setError({ message: toMessage(e, "Failed to stop grid"), sticky: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Configure Grid</h2>
        <p className="text-[11px] text-muted-foreground">
          Range is derived from the live mark · the runner re-checks it before configuring
        </p>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Input label="Symbol" value={form.symbol} onChange={(v) => set("symbol", v)} />
          <Input
            label="Range ±%"
            value={form.rangePct}
            step="0.01"
            min="0.001"
            onChange={(v) => set("rangePct", v)}
          />
          <Input
            label="Grids"
            value={form.gridCount}
            step="1"
            min="2"
            onChange={(v) => set("gridCount", v)}
          />
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Type</span>
            <select
              value={form.gridType}
              onChange={(e) => set("gridType", e.target.value)}
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
            >
              <option value="arithmetic">arithmetic</option>
              <option value="geometric">geometric</option>
            </select>
          </label>
          <Input
            label="Leverage"
            value={form.leverage}
            step="1"
            min="1"
            onChange={(v) => set("leverage", v)}
          />
          <Input
            label="Investment $"
            value={form.investmentUsd}
            step="10"
            min="1"
            onChange={(v) => set("investmentUsd", v)}
          />
          <Input
            label="Qty / grid"
            value={form.qtyPerGrid}
            step="0.001"
            min="0"
            onChange={(v) => set("qtyPerGrid", v)}
          />
          <div className="flex items-end">
            <button
              type="button"
              disabled={busy || !markPrice}
              onClick={() => void create()}
              className="w-full rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              {busy ? "Working…" : "Create Paper Grid"}
            </button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border bg-background/40 p-3">
          {markPrice === null ? (
            <p className="text-xs text-muted-foreground">
              Waiting for a live mark on {symbol} — the range cannot be derived yet.
            </p>
          ) : preview === null ? (
            <p className="text-xs text-bear">Range ±% must be between 0 and 1.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Field label="Mark" value={num(markPrice, 4)} />
              <Field label="Lower" value={num(preview.lowerPrice, 4)} />
              <Field label="Upper" value={num(preview.upperPrice, 4)} />
              <Field label="Step" value={num(preview.step, 4)} />
              <Field
                label="Split"
                value={`${preview.buys} buy / ${preview.sells} sell`}
                tone={preview.buys === 0 || preview.sells === 0 ? "text-bear" : "text-foreground"}
              />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Futures Grid</h2>
        <p className="text-[11px] text-muted-foreground">
          Dashboard writes intent · the runner owns execution
        </p>

        {error && (
          <div className="mt-3 rounded-md border border-bear/40 bg-bear/10 p-2 text-xs text-bear">
            {error.message}
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
                    <Field label="Mark" value={s?.markPrice != null ? num(s.markPrice, 4) : "—"} />
                    <Field
                      label="Range"
                      value={`${num(row.config.lowerPrice, 2)} – ${num(row.config.upperPrice, 2)}`}
                    />
                    <Field label="Position" value={String(s?.positionQty ?? 0)} />
                    <Field
                      label="Unrealized"
                      value={usd(s?.unrealizedPnlUsd ?? 0)}
                      tone={(s?.unrealizedPnlUsd ?? 0) < 0 ? "text-bear" : "text-bull"}
                    />
                    <Field label="Grid profit" value={usd(s?.gridProfitUsd ?? 0)} />
                    <Field
                      label="Orders"
                      value={s ? `${s.buyOrders} buy / ${s.sellOrders} sell` : "—"}
                      tone={
                        s && (s.buyOrders === 0 || s.sellOrders === 0) ? "text-bear" : undefined
                      }
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
    </div>
  );
}
