// Runner-side wiring for the shared Neon-primary/Supabase-mirror store.
// Auth still goes through Supabase (password sign-in) — only persistence
// moved to src/lib/db/edge-store.server.ts, the same module the dashboard's
// server functions use, so both paths agree on one implementation.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  loadBootState as loadBootStateShared,
  persistOpenTrade as persistOpenTradeShared,
  persistCloseTrade as persistCloseTradeShared,
  ingestSignals as ingestSignalsShared,
  upsertHeartbeat as upsertHeartbeatShared,
  type HeartbeatFields,
} from "../src/lib/db/edge-store.server";
import type { OpenTradeInput, CloseTradeInput, SignalInput } from "../src/lib/db/types";
import type { EnginePersistence, EngineBootState } from "../src/lib/engine-runtime";
import type { EdgeReport } from "../src/lib/edge-model";

export function createRunnerSupabaseClient(url: string, publishableKey: string): SupabaseClient {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
}

export async function signInBotUser(
  supabase: SupabaseClient,
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`Runner sign-in failed: ${error?.message ?? "no user"}`);
  return data.user.id;
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
    onPersistError: onError,
  };
}

export async function upsertHeartbeat(
  supabase: SupabaseClient,
  userId: string,
  startedAt: Date,
  fields: HeartbeatFields,
) {
  await upsertHeartbeatShared(supabase, userId, startedAt, fields);
}
