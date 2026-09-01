// Global client middleware that attaches a bearer token to every serverFn
// RPC. The Neon-local session is canonical; an existing Supabase session is
// used as the fallback so those logins keep persisting too (the server-side
// middleware accepts both token kinds). Registered in src/start.ts.
import { createMiddleware } from "@tanstack/react-start";
import { getLocalSession } from "./local-session";

export const attachAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const local = getLocalSession();
  if (local) {
    return next({ headers: { Authorization: `Bearer ${local.token}` } });
  }

  // Fallback: a Supabase browser session. Loaded lazily so the client bundle
  // only pulls it in when there is no local session to use.
  try {
    if (typeof window !== "undefined") {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        return next({ headers: { Authorization: `Bearer ${token}` } });
      }
    }
  } catch {
    // No Supabase session available — fall through unauthenticated.
  }

  return next({ headers: {} });
});
