// Lazy Neon client. Server-only (reads process.env.DATABASE_URL) — never
// import this from a route file or *.functions.ts at the top level, since
// those ship to the client bundle. Load it dynamically inside a server
// handler instead, same convention as integrations/supabase/client.server.ts.
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | undefined;

export function getNeonSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing DATABASE_URL — Neon is not configured.");
    _sql = neon(url);
  }
  return _sql;
}

/** True when DATABASE_URL is configured. */
export function neonEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
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
