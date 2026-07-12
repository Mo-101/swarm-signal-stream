import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SwarmEngine,
  fetchPerpetualSymbols,
  type SymbolState,
  type TradeProposal,
} from "@/lib/swarm";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Swarm Terminal — Live USDT-M Perp Signals" },
      {
        name: "description",
        content:
          "Real-time AI trading swarm streaming every Binance USDT-M perpetual future. Trend, mean-reversion, breakout, and meme-sentiment agents vote on live signals.",
      },
      { property: "og:title", content: "Swarm Terminal — Live USDT-M Perp Signals" },
      {
        property: "og:description",
        content:
          "Live consensus signals from a swarm of AI trading agents across every Binance USDT-M perpetual future. Paper mode.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SwarmDashboard,
});

function formatPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toPrecision(4);
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false });
}

function SwarmDashboard() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ connected: number; total: number }>({
    connected: 0,
    total: 0,
  });
  const [proposals, setProposals] = useState<TradeProposal[]>([]);
  const [ticks, setTicks] = useState(0);
  const [board, setBoard] = useState<SymbolState[]>([]);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"change" | "updates">("change");

  const engineRef = useRef<SwarmEngine | null>(null);
  const tickCounter = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      try {
        const syms = await fetchPerpetualSymbols(ac.signal);
        if (cancelled) return;
        setSymbols(syms);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : "Failed to load symbols from Binance.",
        );
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  useEffect(() => {
    if (symbols.length === 0) return;
    const engine = new SwarmEngine(symbols, {
      onTick: () => {
        tickCounter.current += 1;
      },
      onProposal: (p) => {
        setProposals((prev) => [p, ...prev].slice(0, 60));
      },
      onStatus: (s) => setStatus(s),
    });
    engineRef.current = engine;
    engine.start();

    const boardInterval = setInterval(() => {
      setTicks(tickCounter.current);
      setBoard(engine.getState());
    }, 500);

    return () => {
      clearInterval(boardInterval);
      engine.stop();
      engineRef.current = null;
    };
  }, [symbols]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const rows = q ? board.filter((r) => r.symbol.includes(q)) : board;
    const sorted = [...rows].sort((a, b) => {
      if (sortBy === "change") return Math.abs(b.change1m) - Math.abs(a.change1m);
      return b.updates - a.updates;
    });
    return sorted.slice(0, 60);
  }, [board, query, sortBy]);

  const buyCount = proposals.filter((p) => p.direction === "BUY").length;
  const sellCount = proposals.length - buyCount;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="live-dot h-2.5 w-2.5 rounded-full bg-bull" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Swarm Terminal
              </h1>
              <p className="text-xs text-muted-foreground">
                Live consensus across every Binance USDT-M perpetual future ·
                paper mode
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Stat label="Symbols" value={symbols.length.toString()} />
            <Stat
              label="WS"
              value={`${status.connected}/${status.total}`}
              tone={status.connected === status.total && status.total > 0 ? "bull" : "neutral"}
            />
            <Stat label="Ticks" value={ticks.toLocaleString()} />
            <Stat label="Signals" value={proposals.length.toString()} />
            <Stat label="Buy" value={buyCount.toString()} tone="bull" />
            <Stat label="Sell" value={sellCount.toString()} tone="bear" />
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-auto max-w-[1600px] px-6 pt-4">
          <div className="rounded-md border border-bear/40 bg-bear/10 px-4 py-2 text-sm text-bear">
            {error}
          </div>
        </div>
      )}

      <div className="mx-auto grid max-w-[1600px] gap-4 px-6 py-6 lg:grid-cols-[1fr_1fr]">
        {/* Signals feed */}
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Trade Signals</h2>
              <p className="text-xs text-muted-foreground">
                Weighted consensus of Trend, MeanRev, Breakout, Meme agents
              </p>
            </div>
            <span className="rounded-md bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
              threshold 0.60
            </span>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {proposals.length === 0 ? (
              <EmptyState label="Waiting for consensus signals…" />
            ) : (
              <ul className="divide-y divide-border">
                {proposals.map((p) => (
                  <SignalRow key={p.id} proposal={p} />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Market board */}
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Market Board</h2>
              <p className="text-xs text-muted-foreground">
                Streaming ticks · sorted by {sortBy === "change" ? "|1m change|" : "activity"}
              </p>
            </div>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter…"
                className="w-28 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-primary"
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "change" | "updates")}
                className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-primary"
              >
                <option value="change">Movers</option>
                <option value="updates">Activity</option>
              </select>
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {filtered.length === 0 ? (
              <EmptyState label="Connecting streams…" />
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 text-left font-medium">Symbol</th>
                    <th className="px-4 py-2 text-right font-medium">Price</th>
                    <th className="px-4 py-2 text-right font-medium">1m Δ</th>
                    <th className="px-4 py-2 text-right font-medium">Ticks</th>
                    <th className="px-4 py-2 text-right font-medium">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
                    <BoardRow key={row.symbol} row={row} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      <footer className="mx-auto max-w-[1600px] px-6 pb-8">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Data: Binance USDT-M Futures public WebSocket (aggTrade). This is a
          research and monitoring surface — no orders are placed. Consensus is
          computed browser-side across a weighted ensemble; agents are stateless
          skill evaluators that ingest short rolling price and notional-volume
          windows per symbol and vote each cycle.
        </p>
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "bull" | "bear" | "neutral";
}) {
  const toneClass =
    tone === "bull"
      ? "text-bull"
      : tone === "bear"
        ? "text-bear"
        : tone === "neutral"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-card px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`font-mono text-sm tabular ${toneClass}`}>{value}</div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center px-4 py-16 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function SignalRow({ proposal }: { proposal: TradeProposal }) {
  const isBuy = proposal.direction === "BUY";
  const contribs = Object.entries(proposal.contributions)
    .filter(([, s]) => s.direction !== "NEUTRAL")
    .sort((a, b) => b[1].confidence - a[1].confidence);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div
        className={`mt-0.5 rounded px-2 py-0.5 font-mono text-[11px] font-semibold ${
          isBuy ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"
        }`}
      >
        {proposal.direction}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="truncate font-mono text-sm font-semibold">
            {proposal.symbol}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {formatTime(proposal.time)}
          </div>
        </div>
        <div className="mt-0.5 flex items-baseline gap-3 text-xs text-muted-foreground">
          <span className="font-mono tabular">
            @ {formatPrice(proposal.price)}
          </span>
          <span>
            conf{" "}
            <span
              className={`font-mono ${isBuy ? "text-bull" : "text-bear"}`}
            >
              {proposal.confidence.toFixed(2)}
            </span>
          </span>
        </div>
        {contribs.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {contribs.map(([name, sig]) => (
              <span
                key={name}
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                  sig.direction === "BUY"
                    ? "border-bull/40 text-bull"
                    : "border-bear/40 text-bear"
                }`}
              >
                {name} {sig.direction === "BUY" ? "▲" : "▼"} {sig.confidence.toFixed(2)}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function BoardRow({ row }: { row: SymbolState }) {
  const up = row.lastPrice > row.prevPrice;
  const down = row.lastPrice < row.prevPrice;
  const changeClass =
    row.change1m > 0 ? "text-bull" : row.change1m < 0 ? "text-bear" : "text-muted-foreground";
  return (
    <tr
      key={`${row.symbol}-${row.lastTime}`}
      className={`border-b border-border/50 ${up ? "flash-bull" : down ? "flash-bear" : ""}`}
    >
      <td className="px-4 py-1.5 font-mono text-xs">{row.symbol}</td>
      <td className="px-4 py-1.5 text-right font-mono text-xs tabular">
        {formatPrice(row.lastPrice)}
      </td>
      <td className={`px-4 py-1.5 text-right font-mono text-xs tabular ${changeClass}`}>
        {row.change1m >= 0 ? "+" : ""}
        {row.change1m.toFixed(2)}%
      </td>
      <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-muted-foreground">
        {row.updates}
      </td>
      <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-muted-foreground">
        {formatTime(row.lastTime)}
      </td>
    </tr>
  );
}
