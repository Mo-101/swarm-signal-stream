// Lazy Neon client. Server-only (reads process.env.DATABASE_URL) — never
// import this from a route file or *.functions.ts at the top level, since
// those ship to the client bundle. Load it dynamically inside a server
// handler instead, same convention as integrations/supabase/client.server.ts.
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | undefined;

export function getDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("Missing DATABASE_URL — Neon is not configured.");
  let value = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (value.startsWith("DATABASE_URL=")) value = value.slice("DATABASE_URL=".length).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    value = value.slice(1, -1).trim();
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme.");
  }
  return value;
}

export function getNeonSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    _sql = neon(getDatabaseUrl());
  }
  return _sql;
}

/** True when DATABASE_URL is configured. */
export function neonEnabled(): boolean {
  try {
    return Boolean(getDatabaseUrl());
  } catch {
    return false;
  }
}

/**
 * Neon client when configured, otherwise a no-op tagged template that
 * resolves to an empty result set. Lets the store run Supabase-only
 * (Lovable Cloud) without every write throwing.
 */
export function getNeonSqlOrNoop(): NeonQueryFunction<false, false> {
  if (!neonEnabled()) {
    return (async () => [] as unknown[]) as unknown as NeonQueryFunction<false, false>;
  }
  return getNeonSql();
}

/**
 * Data-plane switch. Neon is the canonical auth and trade/edge store whenever
 * DATABASE_URL is set. Supabase is legacy compatibility only and must be
 * selected explicitly with DATA_STORE=supabase.
 */
export function neonDataEnabled(): boolean {
  const target = (process.env.DATA_STORE ?? "neon").trim().toLowerCase();
  return target !== "supabase" && neonEnabled();
}
