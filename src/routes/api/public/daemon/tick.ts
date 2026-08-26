// Scheduled entry point for the safety-net daemon (pg_cron calls this every
// minute). Public prefix so the scheduler can reach it on the published site,
// therefore the caller is verified here: it must present the project's
// publishable/anon key in an `apikey` header.
import { createFileRoute } from "@tanstack/react-router";

function authorized(request: Request): boolean {
  const provided =
    request.headers.get("apikey") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const expected = [
    process.env["SUPABASE_PUBLISHABLE_KEY"],
    process.env["SUPABASE_ANON_KEY"],
  ].filter((v): v is string => Boolean(v));
  return expected.length > 0 && expected.includes(provided);
}

export const Route = createFileRoute("/api/public/daemon/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const { runDaemonTick } = await import("@/lib/daemon/tick.server");
        const result = await runDaemonTick();
        return Response.json(result, {
          status: result.errors.length ? 500 : 200,
          headers: { "Cache-Control": "no-store" },
        });
      },
      GET: async ({ request }) => {
        if (!authorized(request)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const { runDaemonTick } = await import("@/lib/daemon/tick.server");
        const result = await runDaemonTick();
        return Response.json(result, {
          status: result.errors.length ? 500 : 200,
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
