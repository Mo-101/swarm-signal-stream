// Container-local health signal. Separate from the runner_state DB heartbeat
// (which the dashboard polls) — this is what `docker inspect` / an
// orchestrator's healthcheck can hit without a DB round-trip.
import { createServer, type Server } from "node:http";

export interface HealthStatus {
  status: "starting" | "running" | "halted" | "stopped";
  startedAt: number;
  lastTickAt: number | null;
  equity: number;
  openPositions: number;
  closedTrades: number;
}

export function startHealthServer(port: number, getStatus: () => HealthStatus): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const s = getStatus();
    // Unhealthy if we've never ticked, or gone silent for more than a
    // minute — the price feed reconnects on its own, but a container that's
    // been silent this long is worth an orchestrator restarting.
    const stale = s.lastTickAt !== null && Date.now() - s.lastTickAt > 60_000;
    const healthy = s.status === "running" && s.lastTickAt !== null && !stale;
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(s));
  });
  server.listen(port);
  return server;
}
