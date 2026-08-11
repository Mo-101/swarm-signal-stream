import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SwarmEngine,
  fetchPerpetualSymbols,
  type SwarmMetrics,
  type SymbolState,
  type TradeProposal,
} from "@/lib/swarm";
import {
  PaperBroker,
  DEFAULT_PAPER_CONFIG,
  type Position,
  type ClosedTrade,
} from "@/lib/paper-broker";
import {
  getLiveStatus,
  getLivePositions,
  placeLiveTrade,
  closeLivePosition,
} from "@/lib/live-trader.functions";
import {
  getBybitStatus,
  getBybitPositions,
  placeBybitTrade,
  closeBybitPosition,
} from "@/lib/bybit-trader.functions";

type LiveProvider = "binance" | "bybit";

interface LiveStatus {
  configured: boolean;
  wallet?: number;
  unrealized?: number;
  available?: number;
  error?: string;
  message?: string;
  errorCode?: number;
  errorReason?:
    | "key-invalid"
    | "signature-invalid"
    | "timestamp"
    | "permissions"
    | "ip"
    | "other";
  hint?: string;
  diagnostics?: {
    keyPresent: boolean;
    secretPresent: boolean;
    keyLength: number;
    secretLength: number;
    keyFormatOk: boolean;
    secretFormatOk: boolean;
  };
}
interface LivePosition {
  symbol: string;
  side: "BUY" | "SELL";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealized: number;
  liquidation: number;
  leverage: number;
}
interface LiveLogEntry {
  id: string;
  time: number;
  ok: boolean;
  symbol: string;
  side?: "BUY" | "SELL";
  message: string;
}

const LIVE_CONFIDENCE_THRESHOLD = 0.75;
const LIVE_NOTIONAL_USD = 100;
const LIVE_SL_PCT = 0.008;
const LIVE_TP_PCT = 0.016;
const LIVE_LEVERAGE = 5;
const LIVE_COOLDOWN_MS = 60_000;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Swarm Terminal — Live USDT-M Perp Signals" },
      {
        name: "description",
        content:
          "Real-time AI trading swarm streaming every Bybit USDT perpetual future with paper-trading execution, SL/TP, and PnL tracking.",
      },
      { property: "og:title", content: "Swarm Terminal — Live USDT-M Perp Signals" },
      {
        property: "og:description",
        content:
          "Live consensus signals with paper execution across every Bybit USDT perpetual future.",
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
function formatUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

type Tab = "signals" | "positions" | "history" | "board" | "live";

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
  const [positions, setPositions] = useState<Position[]>([]);
  const [closed, setClosed] = useState<ClosedTrade[]>([]);
  const [realized, setRealized] = useState(0);
  const [unrealized, setUnrealized] = useState(0);
  const [halted, setHalted] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("signals");
  const [query, setQuery] = useState("");
  const [liveMode, setLiveMode] = useState(false);
  const [liveProvider, setLiveProvider] = useState<LiveProvider>("bybit");
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [livePositions, setLivePositions] = useState<LivePosition[]>([]);
  const [liveLog, setLiveLog] = useState<LiveLogEntry[]>([]);

  const engineRef = useRef<SwarmEngine | null>(null);
  const brokerRef = useRef<PaperBroker | null>(null);
  const marksRef = useRef<Map<string, number>>(new Map());
  const tickCounter = useRef(0);
  const liveModeRef = useRef(liveMode);
  const liveProviderRef = useRef(liveProvider);
  const liveCooldownRef = useRef<Map<string, number>>(new Map());
  const liveInFlightRef = useRef<Set<string>>(new Set());

  const placeBinance = useServerFn(placeLiveTrade);
  const fetchBinanceStatus = useServerFn(getLiveStatus);
  const fetchBinancePositions = useServerFn(getLivePositions);
  const closeBinance = useServerFn(closeLivePosition);
  const placeBybit = useServerFn(placeBybitTrade);
  const fetchBybitStatus = useServerFn(getBybitStatus);
  const fetchBybitPositions = useServerFn(getBybitPositions);
  const closeBybit = useServerFn(closeBybitPosition);

  const placeLive = liveProvider === "bybit" ? placeBybit : placeBinance;
  const fetchLiveStatus = liveProvider === "bybit" ? fetchBybitStatus : fetchBinanceStatus;
  const fetchLivePositions =
    liveProvider === "bybit" ? fetchBybitPositions : fetchBinancePositions;
  const closeLive = liveProvider === "bybit" ? closeBybit : closeBinance;

  useEffect(() => {
    liveProviderRef.current = liveProvider;
    // Reset status/positions when switching providers.
    setLiveStatus(null);
    setLivePositions([]);
  }, [liveProvider]);

  useEffect(() => {
    liveModeRef.current = liveMode;
  }, [liveMode]);

  const pushLog = useCallback((entry: Omit<LiveLogEntry, "id" | "time">) => {
    setLiveLog((prev) =>
      [
        { ...entry, id: crypto.randomUUID(), time: Date.now() },
        ...prev,
      ].slice(0, 40),
    );
  }, []);

  const submitLiveTrade = useCallback(
    async (p: TradeProposal) => {
      const now = Date.now();
      const cd = liveCooldownRef.current.get(p.symbol) ?? 0;
      if (now < cd) return;
      if (liveInFlightRef.current.has(p.symbol)) return;
      liveInFlightRef.current.add(p.symbol);
      liveCooldownRef.current.set(p.symbol, now + LIVE_COOLDOWN_MS);
      try {
        const res = await placeLive({
          data: {
            symbol: p.symbol,
            side: p.direction,
            notionalUsd: LIVE_NOTIONAL_USD,
            slPct: LIVE_SL_PCT,
            tpPct: LIVE_TP_PCT,
            refPrice: p.price,
            leverage: LIVE_LEVERAGE,
          },
        });
        pushLog({
          ok: true,
          symbol: p.symbol,
          side: p.direction,
          message: `Filled ${res.quantity} @ ${formatPrice(res.entryPrice)} · SL ${res.slPrice} / TP ${res.tpPrice}`,
        });
      } catch (e) {
        pushLog({
          ok: false,
          symbol: p.symbol,
          side: p.direction,
          message: e instanceof Error ? e.message : "Order failed",
        });
      } finally {
        liveInFlightRef.current.delete(p.symbol);
      }
    },
    [placeLive, pushLog],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchPerpetualSymbols(ac.signal)
      .then(setSymbols)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load symbols."),
      );
    return () => ac.abort();
  }, []);

  // Poll live status/positions when live mode is on.
  useEffect(() => {
    if (!liveMode) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [st, ps] = await Promise.all([
          fetchLiveStatus(),
          fetchLivePositions().catch(() => [] as LivePosition[]),
        ]);
        if (cancelled) return;
        setLiveStatus(st as LiveStatus);
        setLivePositions(ps as LivePosition[]);
      } catch (e) {
        if (!cancelled)
          setLiveStatus({
            configured: true,
            error: e instanceof Error ? e.message : "Live fetch failed",
          });
      }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [liveMode, fetchLiveStatus, fetchLivePositions]);

  useEffect(() => {
    if (symbols.length === 0) return;

    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG, {
      onHalt: (msg) => setHalted(msg),
    });
    brokerRef.current = broker;

    const engine = new SwarmEngine(symbols, {
      onTick: (t) => {
        tickCounter.current += 1;
        marksRef.current.set(t.symbol, t.price);
        broker.markPrice(t.symbol, t.price, t.time);
      },
      onProposal: (p) => {
        setProposals((prev) => [p, ...prev].slice(0, 80));
        broker.onProposal(p);
        if (liveModeRef.current && p.confidence >= LIVE_CONFIDENCE_THRESHOLD) {
          void submitLiveTrade(p);
        }
      },
      onStatus: (s) => setStatus(s),
    });
    engineRef.current = engine;
    engine.start();

    const iv = setInterval(() => {
      setTicks(tickCounter.current);
      setBoard(engine.getState());
      setPositions(broker.getPositions());
      setClosed(broker.getClosed());
      setRealized(broker.getRealizedPnl());
      setUnrealized(broker.getUnrealizedPnl(marksRef.current));
    }, 500);

    return () => {
      clearInterval(iv);
      engine.stop();
      engineRef.current = null;
      brokerRef.current = null;
    };
  }, [symbols]);

  const equity = DEFAULT_PAPER_CONFIG.startingBalance + realized + unrealized;
  const equityPct = ((equity - DEFAULT_PAPER_CONFIG.startingBalance) /
    DEFAULT_PAPER_CONFIG.startingBalance) *
    100;

  const wins = closed.filter((t) => t.pnl > 0).length;
  const winRate = closed.length ? (wins / closed.length) * 100 : 0;

  const filteredBoard = useMemo(() => {
    const q = query.trim().toUpperCase();
    const rows = q ? board.filter((r) => r.symbol.includes(q)) : board;
    return [...rows]
      .sort((a, b) => Math.abs(b.change1m) - Math.abs(a.change1m))
      .slice(0, 60);
  }, [board, query]);

  const closeAll = () => {
    brokerRef.current?.closeAll(marksRef.current, Date.now());
  };
  const resetBroker = () => {
    brokerRef.current?.reset();
    setHalted(null);
  };

  const handleCloseLive = useCallback(
    async (symbol: string) => {
      try {
        await closeLive({ data: { symbol } });
        pushLog({ ok: true, symbol, message: "Position closed via market order." });
        const ps = (await fetchLivePositions().catch(() => [])) as LivePosition[];
        setLivePositions(ps);
      } catch (e) {
        pushLog({
          ok: false,
          symbol,
          message: e instanceof Error ? e.message : "Close failed",
        });
      }
    },
    [closeLive, fetchLivePositions, pushLog],
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className={`live-dot h-2.5 w-2.5 rounded-full ${liveMode ? "bg-accent" : "bg-bull"}`} />
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Swarm Terminal
              </h1>
              <p className="text-xs text-muted-foreground">
                {liveMode
                  ? `LIVE TESTNET · orders placed at conf ≥ ${LIVE_CONFIDENCE_THRESHOLD} · $${LIVE_NOTIONAL_USD} @ ${LIVE_LEVERAGE}× · SL ${(LIVE_SL_PCT * 100).toFixed(1)}% / TP ${(LIVE_TP_PCT * 100).toFixed(1)}%`
                  : `Paper execution · SL ${(DEFAULT_PAPER_CONFIG.slPct * 100).toFixed(1)}% / TP ${(DEFAULT_PAPER_CONFIG.tpPct * 100).toFixed(1)}%`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-border text-[11px] font-semibold">
              {(["bybit", "binance"] as LiveProvider[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setLiveProvider(p)}
                  disabled={liveMode}
                  className={`px-2 py-1.5 transition-colors ${
                    liveProvider === p
                      ? "bg-accent/20 text-accent"
                      : "bg-card text-muted-foreground hover:text-foreground"
                  } ${liveMode ? "cursor-not-allowed opacity-60" : ""}`}
                  title={liveMode ? "Turn off live mode to switch provider" : `Use ${p} testnet`}
                >
                  {p === "bybit" ? "Bybit" : "Binance"}
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                setLiveMode((v) => !v);
                if (!liveMode) setTab("live");
              }}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                liveMode
                  ? "border-accent bg-accent/20 text-accent"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
              title={`Toggle ${liveProvider} testnet live trading`}
            >
              {liveMode ? "● LIVE TESTNET" : "○ Paper mode"}
            </button>
            <Stat
              label="Equity"
              value={formatUsd(equity)}
              sub={`${equityPct >= 0 ? "+" : ""}${equityPct.toFixed(2)}%`}
              tone={equity >= DEFAULT_PAPER_CONFIG.startingBalance ? "bull" : "bear"}
            />
            <Stat
              label="Realized"
              value={formatUsd(realized)}
              tone={realized >= 0 ? "bull" : "bear"}
            />
            <Stat
              label="Unrealized"
              value={formatUsd(unrealized)}
              tone={unrealized >= 0 ? "bull" : "bear"}
            />
            <Stat label="Open" value={`${positions.length}/${DEFAULT_PAPER_CONFIG.maxPositions}`} />
            <Stat label="Trades" value={closed.length.toString()} />
            <Stat
              label="Win%"
              value={closed.length ? `${winRate.toFixed(0)}%` : "—"}
              tone={winRate >= 50 ? "bull" : "bear"}
            />
            <Stat
              label="WS"
              value={`${status.connected}/${status.total}`}
              tone={
                status.connected === status.total && status.total > 0
                  ? "bull"
                  : "neutral"
              }
            />
            <Stat label="Ticks" value={ticks.toLocaleString()} />
          </div>
        </div>
      </header>

      {(error || halted) && (
        <div className="mx-auto max-w-[1600px] space-y-2 px-6 pt-4">
          {error && (
            <div className="rounded-md border border-bear/40 bg-bear/10 px-4 py-2 text-sm text-bear">
              {error}
            </div>
          )}
          {halted && (
            <div className="flex items-center justify-between rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-sm text-accent">
              <span>⚠ {halted}</span>
              <button
                onClick={resetBroker}
                className="rounded border border-accent/40 px-2 py-0.5 text-xs hover:bg-accent/20"
              >
                Reset
              </button>
            </div>
          )}
        </div>
      )}

      <div className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
            {(["signals", "positions", "history", "board", "live"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  tab === t
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
                {t === "signals" && ` (${proposals.length})`}
                {t === "positions" && ` (${positions.length})`}
                {t === "history" && ` (${closed.length})`}
                {t === "live" && ` (${livePositions.length})`}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {positions.length > 0 && (
              <button
                onClick={closeAll}
                className="rounded-md border border-bear/40 bg-bear/10 px-3 py-1.5 text-xs font-medium text-bear hover:bg-bear/20"
              >
                Close all ({positions.length})
              </button>
            )}
            <button
              onClick={resetBroker}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Reset paper account
            </button>
          </div>
        </div>

        <section className="rounded-lg border border-border bg-card">
          {tab === "signals" && <SignalsPanel proposals={proposals} />}
          {tab === "positions" && (
            <PositionsPanel positions={positions} marks={marksRef.current} />
          )}
          {tab === "history" && <HistoryPanel closed={closed} />}
          {tab === "board" && (
            <BoardPanel rows={filteredBoard} query={query} setQuery={setQuery} />
          )}
          {tab === "live" && (
            <LivePanel
              enabled={liveMode}
              provider={liveProvider}
              status={liveStatus}
              positions={livePositions}
              log={liveLog}
              onClose={handleCloseLive}
            />
          )}
        </section>
      </div>


      <footer className="mx-auto max-w-[1600px] px-6 pb-8">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Paper trading against live Bybit USDT perpetual trade streams. Position
          sizing = (equity × {(DEFAULT_PAPER_CONFIG.riskPerTrade * 100).toFixed(1)}%
          × confidence) / stop distance. SL/TP simulated against the live mark;
          fills assumed at signal price. New entries pause automatically if
          realized PnL drops by{" "}
          {(DEFAULT_PAPER_CONFIG.maxDailyDrawdown * 100).toFixed(0)}%. No real
          orders are placed.
        </p>
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
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
      <div className={`font-mono text-sm tabular ${toneClass}`}>
        {value}
        {sub && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">{sub}</span>
        )}
      </div>
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

function SignalsPanel({ proposals }: { proposals: TradeProposal[] }) {
  return (
    <>
      <PanelHeader
        title="Trade Signals"
        subtitle="Weighted consensus of Trend, MeanRev, Breakout, Meme agents"
        badge="threshold 0.60"
      />
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
    </>
  );
}

function PositionsPanel({
  positions,
  marks,
}: {
  positions: Position[];
  marks: Map<string, number>;
}) {
  return (
    <>
      <PanelHeader
        title="Open Positions"
        subtitle="Live mark-to-market with SL/TP simulation"
      />
      <div className="max-h-[70vh] overflow-y-auto">
        {positions.length === 0 ? (
          <EmptyState label="No open positions. Waiting for high-confidence signals…" />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 text-left font-medium">Symbol</th>
                <th className="px-4 py-2 text-left font-medium">Side</th>
                <th className="px-4 py-2 text-right font-medium">Entry</th>
                <th className="px-4 py-2 text-right font-medium">Mark</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 text-right font-medium">SL</th>
                <th className="px-4 py-2 text-right font-medium">TP</th>
                <th className="px-4 py-2 text-right font-medium">uPnL</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const mark = marks.get(p.symbol) ?? p.entryPrice;
                const pnl =
                  p.side === "BUY"
                    ? (mark - p.entryPrice) * p.size
                    : (p.entryPrice - mark) * p.size;
                const pnlPct = (pnl / (p.entryPrice * p.size)) * 100;
                const tone = pnl >= 0 ? "text-bull" : "text-bear";
                return (
                  <tr key={p.id} className="border-b border-border/50">
                    <td className="px-4 py-1.5 font-mono text-xs">{p.symbol}</td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                          p.side === "BUY"
                            ? "bg-bull/15 text-bull"
                            : "bg-bear/15 text-bear"
                        }`}
                      >
                        {p.side}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular">
                      {formatPrice(p.entryPrice)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular">
                      {formatPrice(mark)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-muted-foreground">
                      {p.size.toFixed(4)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-bear">
                      {formatPrice(p.stopLoss)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-bull">
                      {formatPrice(p.takeProfit)}
                    </td>
                    <td className={`px-4 py-1.5 text-right font-mono text-xs tabular ${tone}`}>
                      {formatUsd(pnl)}{" "}
                      <span className="text-[10px] text-muted-foreground">
                        ({pnlPct >= 0 ? "+" : ""}
                        {pnlPct.toFixed(2)}%)
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function HistoryPanel({ closed }: { closed: ClosedTrade[] }) {
  return (
    <>
      <PanelHeader title="Closed Trades" subtitle="Realized PnL history" />
      <div className="max-h-[70vh] overflow-y-auto">
        {closed.length === 0 ? (
          <EmptyState label="No closed trades yet." />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 text-left font-medium">Time</th>
                <th className="px-4 py-2 text-left font-medium">Symbol</th>
                <th className="px-4 py-2 text-left font-medium">Side</th>
                <th className="px-4 py-2 text-right font-medium">Entry → Exit</th>
                <th className="px-4 py-2 text-left font-medium">Reason</th>
                <th className="px-4 py-2 text-right font-medium">PnL</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((t) => {
                const tone = t.pnl >= 0 ? "text-bull" : "text-bear";
                const reasonTone =
                  t.reason === "TP"
                    ? "bg-bull/15 text-bull"
                    : t.reason === "SL"
                      ? "bg-bear/15 text-bear"
                      : "bg-muted text-muted-foreground";
                return (
                  <tr key={t.id + t.closedAt} className="border-b border-border/50">
                    <td className="px-4 py-1.5 font-mono text-[11px] text-muted-foreground">
                      {formatTime(t.closedAt)}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-xs">{t.symbol}</td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                          t.side === "BUY"
                            ? "bg-bull/15 text-bull"
                            : "bg-bear/15 text-bear"
                        }`}
                      >
                        {t.side}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular">
                      {formatPrice(t.entryPrice)} →{" "}
                      <span className="text-foreground">{formatPrice(t.exitPrice)}</span>
                    </td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${reasonTone}`}
                      >
                        {t.reason}
                      </span>
                    </td>
                    <td className={`px-4 py-1.5 text-right font-mono text-xs tabular ${tone}`}>
                      {formatUsd(t.pnl)}{" "}
                      <span className="text-[10px] text-muted-foreground">
                        ({t.pnlPct >= 0 ? "+" : ""}
                        {t.pnlPct.toFixed(2)}%)
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function BoardPanel({
  rows,
  query,
  setQuery,
}: {
  rows: SymbolState[];
  query: string;
  setQuery: (v: string) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Market Board</h2>
          <p className="text-xs text-muted-foreground">
            Top movers by |1m change|
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="w-32 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-primary"
        />
      </div>
      <div className="max-h-[70vh] overflow-y-auto">
        {rows.length === 0 ? (
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
              {rows.map((row) => {
                const up = row.lastPrice > row.prevPrice;
                const down = row.lastPrice < row.prevPrice;
                const changeClass =
                  row.change1m > 0
                    ? "text-bull"
                    : row.change1m < 0
                      ? "text-bear"
                      : "text-muted-foreground";
                return (
                  <tr
                    key={row.symbol}
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
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function PanelHeader({
  title,
  subtitle,
  badge,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && (
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {badge && (
        <span className="rounded-md bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {badge}
        </span>
      )}
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
          <span className="font-mono tabular">@ {formatPrice(proposal.price)}</span>
          <span>
            conf{" "}
            <span className={`font-mono ${isBuy ? "text-bull" : "text-bear"}`}>
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

function LiveErrorPanel({ status }: { status: LiveStatus }) {
  const d = status.diagnostics;
  const reason = status.errorReason;
  const title =
    status.message ??
    (reason === "key-invalid"
      ? "API key is invalid"
      : reason === "signature-invalid"
        ? "Signature mismatch — key and secret do not match"
        : reason === "timestamp"
          ? "Clock drift"
          : reason === "permissions"
            ? "API key missing futures permission"
            : reason === "ip"
              ? "IP not whitelisted"
              : "Testnet request failed");

  const keyState = !d
    ? "unknown"
    : !d.keyPresent
      ? "missing"
      : !d.keyFormatOk
        ? `malformed (${d.keyLength} chars)`
        : `saved (${d.keyLength} chars)`;
  const secretState = !d
    ? "unknown"
    : !d.secretPresent
      ? "missing"
      : !d.secretFormatOk
        ? `malformed (${d.secretLength} chars)`
        : `saved (${d.secretLength} chars)`;

  const pairVerdict =
    !d || !d.keyPresent || !d.secretPresent
      ? "incomplete"
      : reason === "signature-invalid"
        ? "mismatched"
        : reason === "key-invalid"
          ? "invalid key"
          : "saved";

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-bear">⚠ {title}</p>
      {status.error && (
        <p className="break-all font-mono text-[11px] text-bear/80">
          {status.error}
          {status.errorCode !== undefined ? ` (code ${status.errorCode})` : ""}
        </p>
      )}
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="rounded border border-border px-2 py-1">
          API key: <span className="font-mono">{keyState}</span>
        </span>
        <span className="rounded border border-border px-2 py-1">
          API secret: <span className="font-mono">{secretState}</span>
        </span>
        <span
          className={`rounded border px-2 py-1 ${
            pairVerdict === "saved"
              ? "border-bull/40 text-bull"
              : "border-bear/40 text-bear"
          }`}
        >
          Pair: <span className="font-mono">{pairVerdict}</span>
        </span>
      </div>
      {status.hint && (
        <p className="text-[11px] text-muted-foreground">{status.hint}</p>
      )}
    </div>
  );
}



function LivePanel({
  enabled,
  provider,
  status,
  positions,
  log,
  onClose,
}: {
  enabled: boolean;
  provider: LiveProvider;
  status: LiveStatus | null;
  positions: LivePosition[];
  log: LiveLogEntry[];
  onClose: (symbol: string) => void;
}) {
  const providerLabel = provider === "bybit" ? "Bybit" : "Binance";
  return (
    <>
      <PanelHeader
        title={`${providerLabel} Testnet — Live Orders`}
        subtitle={
          enabled
            ? `High-confidence signals are executed on the ${providerLabel} futures testnet with attached SL/TP.`
            : "Enable LIVE TESTNET in the header to route high-confidence signals to real orders."
        }
        badge={enabled ? "LIVE" : "OFF"}
      />
      <div className="border-b border-border px-4 py-3">
        {!enabled ? (
          <p className="text-xs text-muted-foreground">
            Live mode is off. Toggle the LIVE TESTNET button in the header to
            start placing orders on {providerLabel} USDT perpetual futures testnet.
          </p>
        ) : !status ? (
          <p className="text-xs text-muted-foreground">Loading account…</p>
        ) : status.error || status.message ? (
          <LiveErrorPanel status={status} />


        ) : (
          <div className="flex flex-wrap gap-2">
            <Stat label="Wallet" value={formatUsd(status.wallet ?? 0)} />
            <Stat label="Available" value={formatUsd(status.available ?? 0)} />
            <Stat
              label="uPnL"
              value={formatUsd(status.unrealized ?? 0)}
              tone={(status.unrealized ?? 0) >= 0 ? "bull" : "bear"}
            />
            <Stat label="Open" value={positions.length.toString()} />
          </div>
        )}
      </div>

      <div className="border-b border-border">
        <div className="px-4 py-2 text-xs font-semibold text-muted-foreground">
          Open testnet positions
        </div>
        {positions.length === 0 ? (
          <EmptyState label="No open testnet positions." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 text-left font-medium">Symbol</th>
                <th className="px-4 py-2 text-left font-medium">Side</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 text-right font-medium">Entry</th>
                <th className="px-4 py-2 text-right font-medium">Mark</th>
                <th className="px-4 py-2 text-right font-medium">Liq</th>
                <th className="px-4 py-2 text-right font-medium">uPnL</th>
                <th className="px-4 py-2 text-right font-medium">Lev</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const tone = p.unrealized >= 0 ? "text-bull" : "text-bear";
                return (
                  <tr key={p.symbol} className="border-b border-border/50">
                    <td className="px-4 py-1.5 font-mono text-xs">{p.symbol}</td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                          p.side === "BUY"
                            ? "bg-bull/15 text-bull"
                            : "bg-bear/15 text-bear"
                        }`}
                      >
                        {p.side}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular">
                      {p.size}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular">
                      {formatPrice(p.entryPrice)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular">
                      {formatPrice(p.markPrice)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-muted-foreground">
                      {p.liquidation > 0 ? formatPrice(p.liquidation) : "—"}
                    </td>
                    <td className={`px-4 py-1.5 text-right font-mono text-xs tabular ${tone}`}>
                      {formatUsd(p.unrealized)}
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-muted-foreground">
                      {p.leverage}×
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <button
                        onClick={() => onClose(p.symbol)}
                        className="rounded border border-bear/40 px-2 py-0.5 text-[10px] font-medium text-bear hover:bg-bear/10"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <div className="px-4 py-2 text-xs font-semibold text-muted-foreground">
          Order activity
        </div>
        {log.length === 0 ? (
          <EmptyState label="No live orders yet." />
        ) : (
          <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto">
            {log.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {formatTime(e.time)}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                    e.ok
                      ? "bg-bull/15 text-bull"
                      : "bg-bear/15 text-bear"
                  }`}
                >
                  {e.ok ? "OK" : "ERR"}
                </span>
                <span className="font-mono text-xs">{e.symbol}</span>
                {e.side && (
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      e.side === "BUY"
                        ? "bg-bull/15 text-bull"
                        : "bg-bear/15 text-bear"
                    }`}
                  >
                    {e.side}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {e.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

