// Global client middleware that attaches a bearer token to every serverFn
// RPC. Neon-local session first (canonical, works with Supabase down), then
// the Supabase session as fallback. Registered in src/start.ts.
import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getLocalSession } from "./local-session";

export const attachAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const local = getLocalSession();
  if (local) {
    return next({ headers: { Authorization: `Bearer ${local.token}` } });
  }
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    return next({ headers: {} });
  }
});
