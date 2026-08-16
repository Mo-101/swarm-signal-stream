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
  // Authenticate against Neon first. This avoids a network dependency during
  // startup and guarantees the runner uses the same canonical app_users id as
  // the dashboard. Supabase is consulted only for legacy accounts that have
  // not been adopted into Neon yet.
  try {
    const { signInLocal } = await import("../src/lib/auth/local-auth.server");
    const session = await signInLocal(email, password);
    console.log(`[runner] Neon local auth OK (${session.userId})`);
    return session.userId;
  } catch (localError) {
    console.warn(
      `[runner] Neon local sign-in unavailable (${localError instanceof Error ? localError.message : localError}) — trying Supabase fallback`,
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    throw new Error(`Neon and Supabase sign-in failed: ${error?.message ?? "no user"}`);
  }
  const { mirrorSupabaseUser } = await import("../src/lib/auth/local-auth.server");
  await mirrorSupabaseUser(data.user.id, email, password);
  console.log(`[runner] Supabase fallback authenticated and mirrored (${data.user.id})`);
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
