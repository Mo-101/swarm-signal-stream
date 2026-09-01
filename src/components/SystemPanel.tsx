import type { SwarmMetrics } from "@/lib/swarm";

export interface DiscoveryHealth {
  state: "loading" | "ok" | "error";
  count: number;
  durationMs: number;
  at: number | null;
  error: string | null;
}

export interface PaperHealth {
  open: number;
  maxOpen: number;
  realized: number;
  unrealized: number;
  opens: number;
  closes: number;
  lastEventAt: number | null;
  halted: string | null;
}

export interface LiveHealth {
  enabled: boolean;
  provider: string;
  configured: boolean;
  error?: string;
  wallet?: number;
  unrealized?: number;
  positions: number;
  lastUpdated: number | null;
}

function ago(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

function usd(v: number): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Tone = "ok" | "warn" | "bad" | "idle";

const dotTone: Record<Tone, string> = {
  ok: "bg-bull",
  warn: "bg-accent",
  bad: "bg-bear",
  idle: "bg-muted-foreground",
};

function Card({
  title,
  tone,
  status,
  rows,
  children,
}: {
  title: string;
  tone: Tone;
  status: string;
  rows: Array<[string, string]>;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${dotTone[tone]} ${tone === "ok" ? "live-dot" : ""}`} />
          <h3 className="text-xs font-semibold uppercase tracking-wide">{title}</h3>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">{status}</span>
      </div>
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="text-[11px] text-muted-foreground">{k}</dt>
            <dd className="font-mono text-xs tabular">{v}</dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  );
}

export function SystemPanel({
  metrics,
  tickRate,
  peakTickRate,
  discovery,
  paper,
  live,
}: {
  metrics: SwarmMetrics | null;
  tickRate: number;
  peakTickRate: number;
  discovery: DiscoveryHealth;
  paper: PaperHealth;
  live: LiveHealth;
}) {
  const connected = metrics?.connected ?? 0;
  const total = metrics?.total ?? 0;
  const wsTone: Tone =
    total === 0 ? "idle" : connected === total ? "ok" : connected > 0 ? "warn" : "bad";
  const staleMs = metrics?.lastMessageAt ? Date.now() - metrics.lastMessageAt : Infinity;
  const feedTone: Tone =
    !metrics || !metrics.lastMessageAt ? "idle" : staleMs < 5000 ? "ok" : staleMs < 20000 ? "warn" : "bad";
  const discTone: Tone =
    discovery.state === "ok" ? "ok" : discovery.state === "loading" ? "idle" : "bad";
  const avg = metrics?.avgEvalMs ?? 0;
  const voteTone: Tone = !metrics?.evaluations ? "idle" : avg < 2 ? "ok" : avg < 8 ? "warn" : "bad";
  const paperTone: Tone = paper.halted ? "bad" : paper.open > 0 ? "ok" : "idle";
  const liveTone: Tone = !live.enabled
    ? "idle"
    : live.error || !live.configured
      ? "bad"
      : "ok";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">System Status</h2>
          <p className="text-[11px] text-muted-foreground">
            Live health of every feed, agent and execution path
          </p>
        </div>
        <span className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          refresh 500ms
        </span>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
        <Card
          title="WebSocket Connectivity"
          tone={wsTone}
          status={`${connected}/${total} sockets`}
          rows={[
            ["Exchange", metrics?.exchange ?? "—"],
            ["Endpoint", metrics?.wsUrl.replace("wss://", "") ?? "—"],
            ["Reconnects", String((metrics?.feeds ?? []).reduce((a, f) => a + f.reconnects, 0))],
            ["Frames received", (metrics?.totalMessages ?? 0).toLocaleString()],
          ]}
        />

        <Card
          title="Tick Rate"
          tone={feedTone}
          status={`${tickRate.toFixed(1)}/s`}
          rows={[
            ["Peak", `${peakTickRate.toFixed(1)} ticks/s`],
            ["Trades parsed", (metrics?.totalTrades ?? 0).toLocaleString()],
            ["Last message", ago(metrics?.lastMessageAt ?? null)],
            ["Symbols ticking", (metrics?.trackedSymbols ?? 0).toLocaleString()],
          ]}
        />

        <Card
          title="Symbol Discovery"
          tone={discTone}
          status={discovery.state.toUpperCase()}
          rows={[
            ["Perpetuals found", discovery.count.toLocaleString()],
            ["Fetch latency", discovery.durationMs ? `${discovery.durationMs.toFixed(0)} ms` : "—"],
            ["Last refresh", ago(discovery.at)],
            [
              "Coverage",
              discovery.count
                ? `${(((metrics?.trackedSymbols ?? 0) / discovery.count) * 100).toFixed(1)}%`
                : "—",
            ],
          ]}
        >
          {discovery.error && (
            <p className="mt-2 rounded border border-bear/40 bg-bear/10 px-2 py-1 text-[11px] text-bear">
              {discovery.error}
            </p>
          )}
        </Card>

        <Card
          title="Agent Vote Latency"
          tone={voteTone}
          status={`${avg.toFixed(2)} ms avg`}
          rows={[
            ["Evaluations", (metrics?.evaluations ?? 0).toLocaleString()],
            ["Last vote", `${(metrics?.lastEvalMs ?? 0).toFixed(2)} ms`],
            ["Worst vote", `${(metrics?.maxEvalMs ?? 0).toFixed(2)} ms`],
            [
              "Signal yield",
              metrics?.evaluations
                ? `${((metrics.proposals / metrics.evaluations) * 100).toFixed(2)}%`
                : "—",
            ],
          ]}
        />

        <Card
          title="Paper Execution"
          tone={paperTone}
          status={paper.halted ? "HALTED" : "RUNNING"}
          rows={[
            ["Open positions", `${paper.open}/${paper.maxOpen}`],
            ["Realized PnL", usd(paper.realized)],
            ["Unrealized PnL", usd(paper.unrealized)],
            ["Fills / closes", `${paper.opens} / ${paper.closes}`],
            ["Last update", ago(paper.lastEventAt)],
          ]}
        >
          {paper.halted && (
            <p className="mt-2 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent">
              {paper.halted}
            </p>
          )}
        </Card>

        <Card
          title={`Live Execution — ${live.provider}`}
          tone={liveTone}
          status={live.enabled ? (live.configured ? "ARMED" : "NO KEYS") : "OFF"}
          rows={[
            ["Mode", live.enabled ? "Testnet live" : "Disabled"],
            ["Wallet", live.wallet !== undefined ? usd(live.wallet) : "—"],
            [
              "Unrealized",
              live.unrealized !== undefined ? usd(live.unrealized) : "—",
            ],
            ["Open positions", String(live.positions)],
            ["Last poll", ago(live.lastUpdated)],
          ]}
        >
          {live.error && (
            <p className="mt-2 rounded border border-bear/40 bg-bear/10 px-2 py-1 text-[11px] text-bear">
              {live.error}
            </p>
          )}
        </Card>
      </div>

      <div className="border-t border-border px-4 py-3">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Feed shards
        </h3>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-medium">Shard</th>
                <th className="py-1.5 text-right font-medium">Symbols</th>
                <th className="py-1.5 text-right font-medium">State</th>
                <th className="py-1.5 text-right font-medium">Frames</th>
                <th className="py-1.5 text-right font-medium">Trades</th>
                <th className="py-1.5 text-right font-medium">Reconnects</th>
                <th className="py-1.5 text-right font-medium">Last msg</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono tabular">
              {(metrics?.feeds ?? []).map((f) => (
                <tr key={f.chunkId}>
                  <td className="py-1.5 text-left">#{f.chunkId}</td>
                  <td className="py-1.5 text-right">{f.symbols}</td>
                  <td
                    className={`py-1.5 text-right ${
                      f.state === "open"
                        ? "text-bull"
                        : f.state === "connecting"
                          ? "text-accent"
                          : "text-bear"
                    }`}
                  >
                    {f.state}
                  </td>
                  <td className="py-1.5 text-right">{f.messages.toLocaleString()}</td>
                  <td className="py-1.5 text-right">{f.trades.toLocaleString()}</td>
                  <td className="py-1.5 text-right">{f.reconnects}</td>
                  <td className="py-1.5 text-right text-muted-foreground">
                    {ago(f.lastMessageAt)}
                  </td>
                </tr>
              ))}
              {(metrics?.feeds ?? []).length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-muted-foreground">
                    No feed shards yet…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
