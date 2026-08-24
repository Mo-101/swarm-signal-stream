import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { STATE_LABEL, rollup, type HealthComponent, type HealthReport, type HealthState } from "@/lib/health/types";
import type { SwarmMetrics } from "@/lib/swarm";

const POLL_MS = 20_000;
/** A socket that has been open but silent this long is treated as stalled. */
const TICK_STALE_MS = 30_000;

const tone: Record<HealthState, { dot: string; text: string }> = {
  ok: { dot: "bg-bull", text: "text-bull" },
  degraded: { dot: "bg-accent", text: "text-accent" },
  down: { dot: "bg-bear", text: "text-bear" },
  skipped: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

/** Local WebSocket truth — only the tab/runner holding the sockets knows this. */
function streamingComponent(metrics: SwarmMetrics | null): HealthComponent {
  if (!metrics || metrics.total === 0) {
    return {
      id: "ws",
      label: "WebSocket streaming",
      state: "down",
      detail: "No feed sockets started",
    };
  }
  const staleMs = metrics.lastMessageAt ? Date.now() - metrics.lastMessageAt : Infinity;
  if (metrics.connected === 0) {
    return {
      id: "ws",
      label: "WebSocket streaming",
      state: "down",
      detail: `0/${metrics.total} sockets connected`,
    };
  }
  if (staleMs > TICK_STALE_MS) {
    return {
      id: "ws",
      label: "WebSocket streaming",
      state: "down",
      detail: `No frames for ${Math.round(staleMs / 1000)}s`,
    };
  }
  if (metrics.connected < metrics.total || metrics.stalledFeeds > 0) {
    return {
      id: "ws",
      label: "WebSocket streaming",
      state: "degraded",
      detail: `${metrics.connected}/${metrics.total} sockets · ${metrics.stalledFeeds} stalled`,
    };
  }
  return {
    id: "ws",
    label: "WebSocket streaming",
    state: "ok",
    detail: `${metrics.connected}/${metrics.total} sockets · ${metrics.totalMessages.toLocaleString()} frames`,
  };
}

export interface HealthSnapshot {
  status: HealthState;
  components: HealthComponent[];
  checkedAt: number | null;
  error: string | null;
}

/**
 * Polls /api/public/health, merges it with the in-tab socket state and
 * raises a toast whenever overall health changes for the worse (and one when
 * it recovers). Mounted once at dashboard level so alerts fire on any tab.
 */
export function useHealthMonitor(metrics: SwarmMetrics | null): HealthSnapshot {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prev = useRef<HealthState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/public/health", { headers: { Accept: "application/json" } });
        const body = (await res.json()) as HealthReport;
        if (cancelled) return;
        setReport(body);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const ws = streamingComponent(metrics);
  const components: HealthComponent[] = [
    ws,
    ...(report?.components ?? []).filter((c) => c.id !== "ws"),
  ];
  const status: HealthState = error
    ? "degraded"
    : report
      ? rollup(components)
      : ws.state === "ok"
        ? "degraded"
        : ws.state;

  useEffect(() => {
    if (!report && !error) return;
    const before = prev.current;
    prev.current = status;
    if (before === null || before === status) return;
    const failing = components
      .filter((c) => c.state === "down" || c.state === "degraded")
      .map((c) => `${c.label}: ${c.detail}${c.hint ? ` → ${c.hint}` : ""}`)
      .join(" · ");

    if (status === "down") {
      toast.error("System health: DOWN", { description: failing, duration: 15000 });
    } else if (status === "degraded") {
      toast.warning("System health: DEGRADED", { description: failing, duration: 10000 });
    } else if (before === "down" || before === "degraded") {
      toast.success("System health recovered", { description: "All checks passing" });
    }
  }, [status, report, error, components]);

  return { status, components, checkedAt: report?.checkedAt ?? null, error };
}

export function HealthCard({ health }: { health: HealthSnapshot }) {
  const t = tone[health.status];
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${t.dot} ${health.status === "ok" ? "live-dot" : ""}`} />
          <h3 className="text-xs font-semibold uppercase tracking-wide">Health Check</h3>
        </div>
        <span className={`font-mono text-[10px] font-bold ${t.text}`}>
          {STATE_LABEL[health.status]}
        </span>
      </div>
      <dl className="space-y-1.5">
        {health.components.map((c) => (
          <div key={c.id}>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={`h-1.5 w-1.5 rounded-full ${tone[c.state].dot}`} />
                {c.label}
              </dt>
              <dd
                className={`max-w-[60%] truncate text-right font-mono text-[10px] ${tone[c.state].text}`}
                title={c.detail}
              >
                {c.detail}
                {c.httpStatus !== undefined ? ` · HTTP ${c.httpStatus}` : ""}
                {c.latencyMs !== undefined ? ` · ${c.latencyMs}ms` : ""}
              </dd>
            </div>
            {c.hint && (c.state === "down" || c.state === "degraded") ? (
              <p className="mt-0.5 pl-3 text-[10px] leading-snug text-muted-foreground">{c.hint}</p>
            ) : null}
          </div>
        ))}
      </dl>

      <p className="mt-3 font-mono text-[10px] text-muted-foreground">
        {health.error
          ? `probe error: ${health.error}`
          : health.checkedAt
            ? `probed ${Math.max(0, Math.round((Date.now() - health.checkedAt) / 1000))}s ago · GET /api/public/health`
            : "probing…"}
      </p>
    </div>
  );
}
