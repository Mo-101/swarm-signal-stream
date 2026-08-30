import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/auth-middleware";
import { EMPTY_EDGE_REPORT, type EdgeReport } from "@/lib/edge-model";
import type {
  StoredTrade,
  SignalInput,
  OpenTradeInput,
  CloseTradeInput,
  FundingEventInput,
  StoredFundingEvent,
} from "@/lib/db/types";

export type {
  StoredTrade,
  SignalInput,
  OpenTradeInput,
  CloseTradeInput,
  FundingEventInput,
  StoredFundingEvent,
};

export const loadEngineState = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { loadBootState } = await import("@/lib/db/edge-store.server");
    const { boot, report, signalCount } = await loadBootState(context.supabase, context.userId);
    return { ...boot, report, signalCount };
  });

export const getEdgeReport = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    try {
      const { neonDataEnabled, getNeonSql } = await import("@/lib/db/neon");
      if (neonDataEnabled()) {
        const rows = await getNeonSql()`SELECT edge_report(${context.userId}) AS report`;
        const report = rows[0]?.report as EdgeReport | undefined;
        if (report) return report;
      } else {
        const { sbEdgeReport } = await import("@/lib/db/supabase-store.server");
        return await sbEdgeReport(context.supabase);
      }
    } catch (e) {
      console.error("[edge] edge_report failed:", e);
    }
    return EMPTY_EDGE_REPORT;
  });


export const ingestSignals = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { signals: SignalInput[] }) => input)
  .handler(async ({ data, context }) => {
    // Persistence is best-effort: when neither Neon nor the Supabase mirror is
    // reachable this must degrade to "nothing stored", never a 500 that blanks
    // the dashboard.
    try {
      const { ingestSignals: ingest } = await import("@/lib/db/edge-store.server");
      return await ingest(context.supabase, context.userId, data.signals);
    } catch (e) {
      console.error("[edge] ingestSignals failed:", e instanceof Error ? e.message : e);
      return { inserted: 0 };
    }
  });


export const persistOpenTrade = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: OpenTradeInput) => input)
  .handler(async ({ data, context }) => {
    const { persistOpenTrade: persist } = await import("@/lib/db/edge-store.server");
    return persist(context.supabase, context.userId, data);
  });

export const persistCloseTrade = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: CloseTradeInput) => input)
  .handler(async ({ data, context }) => {
    const { persistCloseTrade: persist } = await import("@/lib/db/edge-store.server");
    return persist(context.supabase, context.userId, data);
  });

export const resetPaperAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { wipeHistory: boolean }) => input)
  .handler(async ({ data, context }) => {
    const { resetPaperAccount: reset } = await import("@/lib/db/edge-store.server");
    return reset(context.supabase, context.userId, data.wipeHistory);
  });

// Reads runner_state from Neon directly — the runner writes there as its
// primary store, and Neon is reachable from the server even when the
// Supabase mirror table doesn't exist yet (unapplied migration). Replaces a
// prior version of this poll that queried Supabase from the browser.
export const getRunnerHeartbeat = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    try {
      const { getRunnerHeartbeat: get } = await import("@/lib/db/edge-store.server");
      return await get(context.userId);
    } catch (e) {
      console.error("[edge] getRunnerHeartbeat failed:", e instanceof Error ? e.message : e);
      return null;
    }
  });

