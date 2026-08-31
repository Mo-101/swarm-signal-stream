// Public health probe for uptime monitors, the VPS orchestrator and the
// dashboard status card. Returns 200 while the system is serving (including
// "degraded", which is a warning state the caller reads from `status`), and
// 503 only when a critical component is fully down. No credentials, no
// account values and no user data are ever included in the response.
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const { runHealthChecks } = await import("@/lib/health/checks.server");
        const report = await runHealthChecks();
        // Default to HTTP 200 and let callers read `status` from the body:
        // a 503 on the dashboard's own poll is picked up as an app runtime
        // error. Uptime monitors that want a failing status code opt in with
        // ?strict=1 (used by the container/orchestrator healthchecks).
        const strict = new URL(request.url).searchParams.get("strict") === "1";
        return Response.json(report, {
          status: strict && report.status === "down" ? 503 : 200,
          headers: { ...CORS, "Cache-Control": "no-store", "X-Health-Status": report.status },
        });
      },

    },
  },
});
