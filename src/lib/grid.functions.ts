// Read-only grid state for the dashboard.
//
// The runner is a separate process from the web app, so there is no shared
// engine instance to read — persisted state in futures_grid_state is the only
// honest source. That is deliberate: the frontend reads state, it does not
// own trading logic, and nothing here can configure, start or stop a grid.
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/auth-middleware";
import type { FuturesGridConfig, GridRuntimeState } from "@/lib/futures-grid";

export interface GridStateView {
  config: FuturesGridConfig;
  state: GridRuntimeState;
  active: boolean;
}

export const loadGridStates = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<GridStateView[]> => {
    const { loadAllGridStates } = await import("@/lib/db/edge-store.server");
    return loadAllGridStates(context.userId);
  });

export const loadGridStateForSymbol = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((input: { symbol: string }) => input)
  .handler(async ({ data, context }): Promise<GridStateView | null> => {
    const { loadGridState } = await import("@/lib/db/edge-store.server");
    return loadGridState({ userId: context.userId, symbol: data.symbol });
  });
