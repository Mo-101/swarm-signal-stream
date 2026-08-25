// Dashboard-side read/control plane for Binance demo (testnet) execution.
// Submission happens only in the VPS runner — this file never places an order.
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/auth-middleware";

export interface BinanceDemoParityRow {
  tradeId: string;
  symbol: string;
  side: string;
  phase: string;
  orderType: string;
  paperPrice: number | null;
  fillPrice: number | null;
  slippageBps: number | null;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface BinanceDemoSummary {
  armed: boolean;
  disarmReason: string | null;
  updatedAt: string | null;
  orders: number;
  fills: number;
  rejects: number;
  avgSlippageBps: number | null;
  worstSlippageBps: number | null;
  bySymbol: Array<{ symbol: string; fills: number; avgSlippageBps: number }>;
  recent: BinanceDemoParityRow[];
}

/** Arm state + the live-vs-paper fill parity ledger. */
export const getBinanceDemoSummary = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<BinanceDemoSummary> => {
    const empty: BinanceDemoSummary = {
      armed: false,
      disarmReason: null,
      updatedAt: null,
      orders: 0,
      fills: 0,
      rejects: 0,
      avgSlippageBps: null,
      worstSlippageBps: null,
      bySymbol: [],
      recent: [],
    };

    try {
      const [control, ledger] = await Promise.all([
        context.supabase
          .from("binance_demo_control")
          .select("armed, disarm_reason, updated_at")
          .eq("user_id", context.userId)
          .maybeSingle(),
        context.supabase
          .from("binance_demo_orders")
          .select(
            "trade_id, symbol, side, phase, order_type, paper_price, fill_price, slippage_bps, status, error, created_at",
          )
          .eq("user_id", context.userId)
          .order("created_at", { ascending: false })
          .limit(400),
      ]);

      const c = control.data as
        | { armed?: boolean; disarm_reason?: string | null; updated_at?: string }
        | null;
      const rows = (ledger.data ?? []) as Array<Record<string, unknown>>;

      const recent: BinanceDemoParityRow[] = rows.map((r) => ({
        tradeId: String(r['trade_id'] ?? ""),
        symbol: String(r['symbol'] ?? ""),
        side: String(r['side'] ?? ""),
        phase: String(r['phase'] ?? ""),
        orderType: String(r['order_type'] ?? ""),
        paperPrice: (r['paper_price'] as number | null) ?? null,
        fillPrice: (r['fill_price'] as number | null) ?? null,
        slippageBps: (r['slippage_bps'] as number | null) ?? null,
        status: String(r['status'] ?? ""),
        error: (r['error'] as string | null) ?? null,
        createdAt: String(r['created_at'] ?? ""),
      }));

      const slips = recent.filter((r) => typeof r.slippageBps === "number") as Array<
        BinanceDemoParityRow & { slippageBps: number }
      >;
      const bySymbol = new Map<string, { fills: number; total: number }>();
      for (const s of slips) {
        const agg = bySymbol.get(s.symbol) ?? { fills: 0, total: 0 };
        agg.fills += 1;
        agg.total += s.slippageBps;
        bySymbol.set(s.symbol, agg);
      }

      return {
        armed: Boolean(c?.armed),
        disarmReason: c?.disarm_reason ?? null,
        updatedAt: c?.updated_at ?? null,
        orders: recent.length,
        fills: slips.length,
        rejects: recent.filter((r) => r.status === "rejected").length,
        avgSlippageBps: slips.length
          ? slips.reduce((a, s) => a + s.slippageBps, 0) / slips.length
          : null,
        worstSlippageBps: slips.length ? Math.max(...slips.map((s) => s.slippageBps)) : null,
        bySymbol: [...bySymbol.entries()]
          .map(([symbol, a]) => ({ symbol, fills: a.fills, avgSlippageBps: a.total / a.fills }))
          .sort((a, b) => b.avgSlippageBps - a.avgSlippageBps)
          .slice(0, 8),
        recent: recent.slice(0, 25),
      };
    } catch (e) {
      console.error("[binance-demo] summary failed:", e);
      return empty;
    }
  });

/**
 * Kill switch. Disarming takes effect on the runner's next control poll
 * (≤15s) and leaves paper trading completely untouched.
 */
export const setBinanceDemoArmed = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { armed: boolean; reason?: string }) => ({
    armed: Boolean(input.armed),
    reason: typeof input.reason === "string" ? input.reason.slice(0, 200) : undefined,
  }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("binance_demo_control").upsert(
      {
        user_id: context.userId,
        armed: data.armed,
        disarm_reason: data.armed ? null : (data.reason ?? "disarmed from dashboard"),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return { armed: data.armed };
  });
