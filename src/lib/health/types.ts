// Shared health-check contract. Imported by both the public API route
// (server) and the dashboard card (client), so this file must stay free of
// any server-only imports.

export type HealthState = "ok" | "degraded" | "down" | "skipped";

export interface HealthComponent {
  /** Stable id, e.g. "stream", "execution", "redis". */
  id: string;
  label: string;
  state: HealthState;
  /** Human-readable one-liner shown in the card and returned by the API. */
  detail: string;
  /** Probe round-trip in ms, when the check performed I/O. */
  latencyMs?: number;
}

export interface HealthReport {
  status: HealthState;
  checkedAt: number;
  durationMs: number;
  components: HealthComponent[];
}

const RANK: Record<HealthState, number> = { ok: 0, skipped: 0, degraded: 1, down: 2 };

export function rollup(components: HealthComponent[]): HealthState {
  let worst: HealthState = "ok";
  for (const c of components) {
    if (RANK[c.state] > RANK[worst]) worst = c.state;
  }
  return worst;
}

export const STATE_LABEL: Record<HealthState, string> = {
  ok: "OPERATIONAL",
  degraded: "DEGRADED",
  down: "DOWN",
  skipped: "NOT CONFIGURED",
};
