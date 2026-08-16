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
  // Supabase first (keeps its session for the mirror writes), but Neon-local
  // auth is canonical: if Supabase is unreachable or rejects, fall back to
  // app_users in Neon so the runner keeps trading through outages.
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data.user) {
      const { mirrorSupabaseUser } = await import("../src/lib/auth/local-auth.server");
      await mirrorSupabaseUser(data.user.id, email, password);
      return data.user.id;
    }
    console.warn(
      `[runner] Supabase sign-in failed (${error?.message ?? "no user"}) — using Neon local auth`,
    );
  } catch (e) {
    console.warn(
      `[runner] Supabase unreachable (${e instanceof Error ? e.message : e}) — using Neon local auth`,
    );
  }
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
