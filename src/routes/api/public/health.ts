// Public health probe for uptime monitors, the VPS orchestrator and the
// dashboard status card. Returns 200 when everything configured is healthy,
// 503 as soon as any component is degraded or down. No credentials, no
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
      GET: async () => {
        const { runHealthChecks } = await import("@/lib/health/checks.server");
        const report = await runHealthChecks();
        return Response.json(report, {
          status: report.status === "ok" ? 200 : 503,
          headers: { ...CORS, "Cache-Control": "no-store" },
        });
      },
    },
  },
});
