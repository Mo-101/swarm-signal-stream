// Runner-side wiring for the shared Neon-primary/Supabase-mirror store.
// Neon-local auth and persistence are canonical. Supabase is retained only
// as a best-effort compatibility mirror/fallback.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  loadBootState as loadBootStateShared,
  persistOpenTrade as persistOpenTradeShared,
  persistCloseTrade as persistCloseTradeShared,
  ingestSignals as ingestSignalsShared,
  upsertHeartbeat as upsertHeartbeatShared,
  persistShadowOpen as persistShadowOpenShared,
  persistShadowClose as persistShadowCloseShared,
  loadShadowBook as loadShadowBookShared,
  persistGridRuntimeBySymbol as persistGridRuntimeBySymbolShared,
  loadGridStatesForUser as loadGridStatesForUserShared,
  type HeartbeatFields,
} from "../src/lib/db/edge-store.server";
import type { FuturesGridConfig, GridRuntimeState } from "../src/lib/futures-grid";
import type { OpenTradeInput, CloseTradeInput, SignalInput } from "../src/lib/db/types";
import type { EnginePersistence, EngineBootState } from "../src/lib/engine-runtime";
import { ENGINE_SHADOW_CONFIG } from "../src/lib/engine-runtime";
import {
  shadowEconomicsOf,
  type ShadowBookSnapshot,
  type ShadowTrade,
} from "../src/lib/shadow-book";
import type { EdgeReport } from "../src/lib/edge-model";

function validHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function createRunnerSupabaseClient(
  url?: string,
  publishableKey?: string,
): SupabaseClient {
  // A local discard endpoint keeps the mirror interface available without
  // making Supabase configuration a startup requirement. Neon operations are
  // awaited; mirror calls are already best-effort and log their own failures.
  const mirrorEnabled = validHttpUrl(url) && Boolean(publishableKey?.trim());
  if (!mirrorEnabled) {
    console.warn("[runner] Supabase mirror disabled; Neon remains canonical");
  }
  return createClient(
    mirrorEnabled ? url : "http://127.0.0.1:9",
    mirrorEnabled ? publishableKey! : "supabase-disabled",
    {
    auth: { persistSession: false, autoRefreshToken: true },
    },
  );
}

export async function signInBotUser(
  _supabase: SupabaseClient,
  email: string,
  password: string,
): Promise<string> {
  const { signInLocal } = await import("../src/lib/auth/local-auth.server");
  const session = await signInLocal(email, password);
  console.log(`[runner] Neon local auth OK (${session.userId})`);
  return session.userId;
}

export async function loadBootState(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ boot: EngineBootState; report: EdgeReport; signalCount: number }> {
  return loadBootStateShared(supabase, userId);
}

export function createSupabasePersistence(
  supabase: SupabaseClient,
  userId: string,
  onError: (message: string) => void,
): EnginePersistence {
  return {
    async saveOpenTrade(data: OpenTradeInput) {
      await persistOpenTradeShared(supabase, userId, data);
    },
    async saveCloseTrade(data: CloseTradeInput) {
      return persistCloseTradeShared(supabase, userId, data);
    },
    async sendSignals(signals: SignalInput[]) {
      await ingestSignalsShared(supabase, userId, signals);
    },
    async saveShadowOpen(trade: ShadowTrade) {
      await persistShadowOpenShared(userId, trade);
    },
    async saveShadowClose(trade: ShadowTrade) {
      await persistShadowCloseShared(userId, trade);
    },
    async saveGridState(config: FuturesGridConfig, state: GridRuntimeState) {
      // Runtime marking only. The lifecycle status belongs to the coordinator;
      // this path may escalate to halted but must never demote 'running'.
      await persistGridRuntimeBySymbolShared({
        userId,
        symbol: config.symbol,
        runtimeState: state,
        halted: Boolean(state.haltReasons?.length),
      });
    },
    onPersistError: onError,
  };
}

/**
 * Grids previously configured for this user, restored verbatim at boot.
 * Only rows the runner had actually configured (runtime_state present) are
 * restored — a row that is merely *desired* is left for the coordinator to
 * apply, so restore never front-runs validation.
 */
export async function loadGridBoot(
  userId: string,
): Promise<Array<{ config: FuturesGridConfig; state: GridRuntimeState }>> {
  const stored = await loadGridStatesForUserShared(userId);
  return stored
    .filter((row) => row.runtimeState !== null)
    .map((row) => ({ config: row.config, state: row.runtimeState as GridRuntimeState }));
}

/**
 * Load the persisted shadow book under the engine's own economics, so the
 * counterfactual resumes across restarts instead of restarting its evidence.
 */
export async function loadShadowBoot(userId: string): Promise<ShadowBookSnapshot> {
  return loadShadowBookShared(userId, shadowEconomicsOf(ENGINE_SHADOW_CONFIG), {
    maxOpen: ENGINE_SHADOW_CONFIG.maxOpen,
    maxClosed: ENGINE_SHADOW_CONFIG.maxClosed,
  });
}

export async function upsertHeartbeat(
  supabase: SupabaseClient,
  userId: string,
  startedAt: Date,
  fields: HeartbeatFields,
) {
  await upsertHeartbeatShared(supabase, userId, startedAt, fields);
}
