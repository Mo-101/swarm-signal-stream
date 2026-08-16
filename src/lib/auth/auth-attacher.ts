// Global client middleware that attaches a bearer token to every serverFn
// RPC using the Neon-local session. Registered in src/start.ts.
import { createMiddleware } from "@tanstack/react-start";
import { getLocalSession } from "./local-session";

export const attachAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const local = getLocalSession();
  if (local) {
    return next({ headers: { Authorization: `Bearer ${local.token}` } });
  }
  return next({ headers: {} });
});
