// Auth middleware for server functions: Neon-local tokens are canonical and
// verified first (no network round-trip); Supabase JWTs remain accepted as
// the fallback so existing sessions keep working. Both paths yield the same
// context shape ({ supabase, userId, claims }) the *.functions.ts handlers
// already expect.
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function makeSupabaseClient(token?: string): SupabaseClient<Database> {
  const configuredUrl = process.env["SUPABASE_URL"];
  const configuredKey = process.env["SUPABASE_PUBLISHABLE_KEY"];
  let validUrl = false;
  try {
    const parsed = configuredUrl ? new URL(configuredUrl) : null;
    validUrl = parsed?.protocol === "http:" || parsed?.protocol === "https:";
  } catch {
    validUrl = false;
  }
  const mirrorEnabled = validUrl && Boolean(configuredKey?.trim());
  const supabaseUrl = mirrorEnabled ? configuredUrl! : "http://127.0.0.1:9";
  const supabaseKey = mirrorEnabled ? configuredKey! : "supabase-disabled";
  return createClient<Database>(supabaseUrl, supabaseKey, {
    global: {
      fetch: createSupabaseFetch(supabaseKey),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

interface AuthContext {
  supabase: SupabaseClient<Database>;
  userId: string;
  claims: Record<string, unknown>;
}

async function resolveAuthContext(token: string): Promise<AuthContext> {
  // 1) Neon-local token (canonical — verified with a local HMAC check).
  const { verifyLocalToken } = await import("./local-auth.server");
  const local = verifyLocalToken(token);
  if (local) {
    return {
      // Unauthenticated client: Supabase mirror writes become best-effort
      // no-ops behind RLS, which is exactly what "fallback only" means.
      supabase: makeSupabaseClient(),
      userId: local.userId,
      claims: { sub: local.userId, email: local.email, iss: "alpha-swarm-local" },
    };
  }

  // 2) Supabase JWT fallback.
  const supabase = makeSupabaseClient(token);
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    throw new Error("Unauthorized: Invalid token");
  }
  return { supabase, userId: data.claims.sub, claims: data.claims as Record<string, unknown> };
}

export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const request = getRequest();
  const authHeader = request?.headers?.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Unauthorized: No bearer token provided");
  }
  const token = authHeader.slice("Bearer ".length);
  if (!token || token.split(".").length !== 3) {
    throw new Error("Unauthorized: Invalid token");
  }
  const context = await resolveAuthContext(token);
  return next({ context });
});
