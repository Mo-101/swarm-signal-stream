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
  type MarginSummary,
  type ClosedTrade,
  type ExecutionStats,
  type PendingOrder,
  type RejectRecord,
} from "@/lib/paper-broker";
import {
  MicrostructureFeed,
  fetchInstrumentFilters,
  type MicroMetrics,
} from "@/lib/microstructure";

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
import { SystemPanel, type DiscoveryHealth } from "@/components/SystemPanel";
import { EdgePanel } from "@/components/EdgePanel";
import { ExecutionPanel } from "@/components/ExecutionPanel";

import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "@tanstack/react-router";
import { setAgentWeights } from "@/lib/swarm";
import {
  confBucket,
  deriveEdge,
  regimeOf,
  EMPTY_EDGE_REPORT,
  type EdgeReport,
  type LearnedEdge,
} from "@/lib/edge-model";
import {
  loadEngineState,
  ingestSignals,
  persistOpenTrade,
  persistCloseTrade,
  resetPaperAccount,
  type SignalInput,
} from "@/lib/edge.functions";

type LiveProvider = "binance" | "bybit";

interface LiveStatus {
  configured: boolean;
  env?: "testnet" | "mainnet";
  wallet?: number;
  unrealized?: number;
  available?: number;
  error?: string;
  warning?: string;
  message?: string;
  errorCode?: number;
  wrongVenue?: "testnet" | "mainnet" | null;
  errorReason?:
    | "key-invalid"
    | "signature-invalid"
    | "timestamp"
    | "permissions"
    | "ip"
    | "network-blocked"
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
  /** Repeats of the same message collapse into one row with a count. */
  count?: number;
}

const LIVE_CONFIDENCE_THRESHOLD = 0.75;
const LIVE_NOTIONAL_USD = 100;
const LIVE_SL_PCT = 0.008;
const LIVE_TP_PCT = 0.016;
const LIVE_LEVERAGE = 5;
const LIVE_COOLDOWN_MS = 60_000;
/** Consecutive live-order failures before live mode disarms itself. */
const LIVE_FAILURE_LIMIT = 3;
/** Closed paper trades required before live arming unlocks for review. */
const REVIEW_TRADE_TARGET = 100;

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}


export const Route = createFileRoute("/_authenticated/dashboard")({
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

type Tab =
  | "signals"
  | "positions"
  | "history"
  | "board"
  | "execution"
  | "edge"
  | "live"
  | "system";

const EMPTY_EXEC_STATS: ExecutionStats = {
  submitted: 0,
  filled: 0,
  partialFills: 0,
  rejected: 0,
  pending: 0,
  rejectsByReason: {},
  avgEntrySlipBps: 0,
  avgExitSlipBps: 0,
  worstSlipBps: 0,
  avgSpreadBps: 0,
  avgFillLatencyMs: 0,
  avgFillRatio: 0,
  slipCostUsd: 0,
  bookPricedFills: 0,
  modelPricedFills: 0,
};


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
  /** Non-null when the circuit breaker disarmed live mode; holds the reason. */
  const [liveTripped, setLiveTripped] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<SwarmMetrics | null>(null);
  const [tickRate, setTickRate] = useState(0);
  const [peakTickRate, setPeakTickRate] = useState(0);
  const [paperOpens, setPaperOpens] = useState(0);
  const [lastPaperEventAt, setLastPaperEventAt] = useState<number | null>(null);
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<number | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryHealth>({
    state: "loading",
    count: 0,
    durationMs: 0,
    at: null,
    error: null,
  });

  const [edgeReport, setEdgeReport] = useState<EdgeReport>(EMPTY_EDGE_REPORT);
  const [boot, setBoot] = useState<Awaited<ReturnType<typeof loadEngineState>> | null>(null);
  const [storedSignals, setStoredSignals] = useState(0);
  const [storedTrades, setStoredTrades] = useState(0);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [costs, setCosts] = useState({ fees: 0, funding: 0 });
  const [margin, setMargin] = useState<MarginSummary>({
    usedMargin: 0,
    maintenanceMargin: 0,
    availableMargin: DEFAULT_PAPER_CONFIG.startingBalance,
    equity: DEFAULT_PAPER_CONFIG.startingBalance,
    marginRatio: 0,
    atRisk: 0,
  });
  const [liquidations, setLiquidations] = useState(0);
  const [execStats, setExecStats] = useState<ExecutionStats>(EMPTY_EXEC_STATS);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [rejects, setRejects] = useState<RejectRecord[]>([]);
  const [microMetrics, setMicroMetrics] = useState<MicroMetrics | null>(null);
  const microRef = useRef<MicrostructureFeed | null>(null);



  const navigate = useNavigate();
  const loadState = useServerFn(loadEngineState);
  const sendSignals = useServerFn(ingestSignals);
  const saveOpen = useServerFn(persistOpenTrade);
  const saveClose = useServerFn(persistCloseTrade);
  const resetAccount = useServerFn(resetPaperAccount);

  const learned: LearnedEdge = useMemo(
    () => deriveEdge(edgeReport, DEFAULT_PAPER_CONFIG.minConfidence),
    [edgeReport],
  );
  const learnedRef = useRef(learned);
  const regimeRef = useRef<Map<string, string>>(new Map());
  const signalBufferRef = useRef<SignalInput[]>([]);

  const engineRef = useRef<SwarmEngine | null>(null);
  const brokerRef = useRef<PaperBroker | null>(null);
  const marksRef = useRef<Map<string, number>>(new Map());
  const tickCounter = useRef(0);
  const liveModeRef = useRef(liveMode);
  const liveProviderRef = useRef(liveProvider);
  const liveCooldownRef = useRef<Map<string, number>>(new Map());
  const liveInFlightRef = useRef<Set<string>>(new Set());
  /** Proven-armed: credentials present AND an account probe succeeded. */
  const liveReadyRef = useRef(false);
  const liveFailStreakRef = useRef(0);


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
    setLiveLog((prev) => {
      // Collapse an identical repeat of the newest row into a counter instead
      // of flooding the feed with one line per rejected signal.
      const head = prev[0];
      if (head && head.ok === entry.ok && head.message === entry.message) {
        const merged: LiveLogEntry = {
          ...head,
          time: Date.now(),
          symbol: head.symbol === entry.symbol ? head.symbol : "—",
          count: (head.count ?? 1) + 1,
        };
        return [merged, ...prev.slice(1)];
      }
      return [
        { ...entry, id: crypto.randomUUID(), time: Date.now() },
        ...prev,
      ].slice(0, 40);
    });
  }, []);

  const submitLiveTrade = useCallback(
    async (p: TradeProposal) => {
      // Readiness gate: never fire an order at a venue we know isn't armed.
      if (!liveReadyRef.current) return;
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
        liveFailStreakRef.current = 0;
        pushLog({
          ok: true,
          symbol: p.symbol,
          side: p.direction,
          message: `Filled ${res.quantity} @ ${formatPrice(res.entryPrice)} · SL ${res.slPrice} / TP ${res.tpPrice}`,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Order failed";
        pushLog({ ok: false, symbol: p.symbol, side: p.direction, message });
        liveFailStreakRef.current += 1;
        if (liveFailStreakRef.current >= LIVE_FAILURE_LIMIT) {
          // Circuit breaker: disarm rather than spray failing orders.
          liveReadyRef.current = false;
          liveModeRef.current = false;
          setLiveMode(false);
          setLiveTripped(message);
          pushLog({
            ok: false,
            symbol: "SYSTEM",
            message: `Live mode disarmed after ${LIVE_FAILURE_LIMIT} consecutive failures — ${message}`,
          });
        }
      } finally {
        liveInFlightRef.current.delete(p.symbol);
      }
    },
    [placeLive, pushLog],
  );


  useEffect(() => {
    const ac = new AbortController();
    const t0 = performance.now();
    setDiscovery((d) => ({ ...d, state: "loading", error: null }));
    fetchPerpetualSymbols(ac.signal)
      .then((list) => {
        setSymbols(list);
        setDiscovery({
          state: "ok",
          count: list.length,
          durationMs: performance.now() - t0,
          at: Date.now(),
          error: null,
        });
      })
      .catch((e) => {
        // Effect cleanup (remount / navigation) aborts the in-flight fetch —
        // that is not a discovery failure, so don't surface it as an error.
        if (ac.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Failed to load symbols.";
        setError(msg);
        setDiscovery({
          state: "error",
          count: 0,
          durationMs: performance.now() - t0,
          at: Date.now(),
          error: msg,
        });
      });
    return () => ac.abort(new DOMException("dashboard unmounted", "AbortError"));

  }, []);

  // Probe the venue continuously — readiness must be proven before arming,
  // not discovered by firing orders at it.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [st, ps] = await Promise.all([
          fetchLiveStatus(),
          liveModeRef.current
            ? fetchLivePositions().catch(() => [] as LivePosition[])
            : Promise.resolve([] as LivePosition[]),
        ]);
        if (cancelled) return;
        const status = st as LiveStatus;
        setLiveStatus(status);
        liveReadyRef.current = status.configured && !status.error;
        if (!liveReadyRef.current && liveModeRef.current) {
          liveModeRef.current = false;
          setLiveMode(false);
          setLiveTripped(status.error ?? status.message ?? "Venue is not reachable.");
        }
        setLivePositions(ps as LivePosition[]);
        setLiveUpdatedAt(Date.now());
      } catch (e) {
        if (cancelled) return;
        liveReadyRef.current = false;
        setLiveStatus({
          configured: true,
          error: e instanceof Error ? e.message : "Live fetch failed",
        });
      }
    };
    load();
    const iv = setInterval(load, liveMode ? 5000 : 20000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [liveMode, fetchLiveStatus, fetchLivePositions]);


  // Load the persisted account, open positions, history and edge report.
  useEffect(() => {
    let cancelled = false;
    loadState()
      .then((state) => {
        if (cancelled) return;
        setBoot(state);
        setEdgeReport(state.report ?? EMPTY_EDGE_REPORT);
        setStoredSignals(state.signalCount ?? 0);
        setStoredTrades(state.open.length + state.closed.length);
      })
      .catch((e) => {
        if (cancelled) return;
        setPersistError(e instanceof Error ? e.message : "Could not load stored state");
        setBoot({
          account: { startingBalance: DEFAULT_PAPER_CONFIG.startingBalance, realizedPnl: 0, halted: false },
          open: [],
          closed: [],
          report: EMPTY_EDGE_REPORT,
          signalCount: 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [loadState]);

  // Feed learned edge back into the running swarm.
  useEffect(() => {
    learnedRef.current = learned;
    setAgentWeights(learned.agentWeights);
    brokerRef.current?.setMinConfidence(learned.minConfidence);
  }, [learned]);

  // Flush buffered signals to storage.
  useEffect(() => {
    if (!boot) return;
    const iv = setInterval(() => {
      const batch = signalBufferRef.current.splice(0, 200);
      if (batch.length === 0) return;
      void sendSignals({ data: { signals: batch } })
        .then(() => setStoredSignals((n) => n + batch.length))
        .catch((e) =>
          setPersistError(e instanceof Error ? e.message : "Signal ingest failed"),
        );
    }, 8000);
    return () => clearInterval(iv);
  }, [boot, sendSignals]);

  useEffect(() => {
    if (symbols.length === 0 || !boot) return;

    // Depth / mark-price feed for the hot symbol set — the execution realism layer.
    const micro = new MicrostructureFeed();
    microRef.current = micro;

    const broker = new PaperBroker(DEFAULT_PAPER_CONFIG, {
      onHalt: (msg) => setHalted(msg),
      onReject: (r) => setRejects((prev) => [r, ...prev].slice(0, 60)),
      onOpen: (pos) => {
        setPaperOpens((n) => n + 1);
        setLastPaperEventAt(Date.now());
        setStoredTrades((n) => n + 1);
        void saveOpen({
          data: {
            clientId: pos.id,
            symbol: pos.symbol,
            side: pos.side,
            entryPrice: pos.entryPrice,
            size: pos.size,
            notional: pos.notional,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            confidence: pos.confidence,
            confBucket: confBucket(pos.confidence),
            regime: pos.regime,
            hourUtc: new Date(pos.openedAt).getUTCHours(),
            agents: pos.agents,
            openedAt: pos.openedAt,
            signalPrice: pos.signalPrice,
            entrySlipBps: pos.entrySlipBps,
            spreadEntryBps: pos.spreadAtEntryBps,
            latencyMs: pos.latencyMs,
            leverage: pos.leverage,
            liqPrice: pos.liquidationPrice,
            bookPriced: pos.bookPriced,
          },
        }).catch((e) =>
          setPersistError(e instanceof Error ? e.message : "Trade save failed"),
        );
      },
      onClose: (trade) => {
        setLastPaperEventAt(Date.now());
        void saveClose({
          data: {
            clientId: trade.id,
            exitPrice: trade.exitPrice,
            pnl: trade.pnl,
            pnlPct: trade.pnlPct,
            reason: trade.reason,
            closedAt: trade.closedAt,
            realizedPnl: broker.getRealizedPnl(),
            halted: broker.isHalted(),
            triggerPrice: trade.triggerPrice,
            exitSlipBps: trade.exitSlipBps,
            spreadExitBps: trade.spreadAtExitBps,
            slipCostUsd: trade.slipCostUsd,
            grossPnl: trade.grossPnl,
            fees: trade.fees,
            funding: trade.funding,
          },
        })
          .then((res) => setEdgeReport(res.report ?? EMPTY_EDGE_REPORT))
          .catch((e) =>
            setPersistError(e instanceof Error ? e.message : "Trade close save failed"),
          );
      },
    });
    broker.setMarket({
      book: (s) => micro.getBook(s),
      mark: (s) => micro.getMark(s),
      filter: (s) => micro.filter(s),
    });

    broker.setMinConfidence(learnedRef.current.minConfidence);
    broker.hydrate({
      positions: boot.open.map((t) => ({
        id: t.clientId,
        symbol: t.symbol,
        side: t.side,
        entryPrice: t.entryPrice,
        size: t.size,
        notional: t.notional,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        openedAt: t.openedAt,
        confidence: t.confidence,
        regime: t.regime,
        agents: t.agents as Position["agents"],
      })),
      closed: boot.closed
        .filter((t) => t.exitPrice !== null && t.closedAt !== null)
        .map((t) => ({
          id: t.clientId,
          symbol: t.symbol,
          side: t.side,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice as number,
          size: t.size,
          pnl: t.pnl ?? 0,
          pnlPct: t.pnlPct ?? 0,
          reason: (t.reason as ClosedTrade["reason"]) ?? "MANUAL",
          openedAt: t.openedAt,
          closedAt: t.closedAt as number,
          confidence: t.confidence,
          regime: t.regime,
          agents: t.agents as Position["agents"],
        })),
      realizedPnl: boot.account.realizedPnl,
      halted: boot.account.halted,
    });
    brokerRef.current = broker;

    // Exchange instrument filters (tick / lot / min-notional) then depth feed.
    void fetchInstrumentFilters()
      .then((f) => micro.setFilters(f))
      .catch(() => setPersistError("Instrument filters unavailable — fills will be rejected"));
    micro.start();

    let lastPendingSweep = 0;
    const engine = new SwarmEngine(symbols, {
      onTick: (t) => {
        tickCounter.current += 1;
        marksRef.current.set(t.symbol, t.price);
        broker.markPrice(t.symbol, t.price, t.time);
        // Tick-driven matching: a backgrounded tab throttles setInterval to
        // ~1Hz, but socket frames keep arriving, so drive fills from them too.
        const now = Date.now();
        if (now - lastPendingSweep > 50) {
          lastPendingSweep = now;
          broker.processPending(now);
        }
      },

      onProposal: (p) => {
        setProposals((prev) => [p, ...prev].slice(0, 80));
        const regime = regimeRef.current.get(p.symbol) ?? "unknown";
        const edge = learnedRef.current;
        const suppressed =
          edge.suppressedSymbols.includes(p.symbol) ||
          edge.costSuppressedSymbols.includes(p.symbol);
        const before = broker.getPositions().length + broker.getPending().length;
        if (!suppressed) broker.onProposal(p, { regime });
        const executed = broker.getPositions().length + broker.getPending().length > before;
        signalBufferRef.current.push({
          symbol: p.symbol,
          side: p.direction,
          price: p.price,
          confidence: p.confidence,
          confBucket: confBucket(p.confidence),
          regime,
          hourUtc: new Date(p.time).getUTCHours(),
          agents: p.contributions,
          executed,
        });
        if (signalBufferRef.current.length > 400) {
          signalBufferRef.current.splice(0, signalBufferRef.current.length - 400);
        }
        if (liveModeRef.current && p.confidence >= LIVE_CONFIDENCE_THRESHOLD) {
          void submitLiveTrade(p);
        }
      },
      onStatus: (s) => setStatus(s),
    });
    engineRef.current = engine;
    engine.start();

    // Pull Bybit's live funding rates so paper carry matches the real book.
    const loadFunding = async () => {
      try {
        const res = await fetch(
          "https://api.bybit.com/v5/market/tickers?category=linear",
        );
        const json = (await res.json()) as {
          result?: { list?: Array<{ symbol: string; fundingRate: string }> };
        };
        for (const t of json.result?.list ?? []) {
          const rate = Number(t.fundingRate);
          if (Number.isFinite(rate)) broker.setFundingRate(t.symbol, rate);
        }
      } catch {
        // Keep the default 0.01%/8h assumption when the REST call fails.
      }
    };
    void loadFunding();
    const fundingIv = setInterval(loadFunding, 5 * 60 * 1000);

    // Matching engine tick: fill in-flight orders as soon as their latency
    // elapses, using whatever the book looks like at that moment.
    const matchIv = setInterval(() => broker.processPending(Date.now()), 100);

    // Keep full depth on what matters: open positions, orders in flight, then
    // the hottest movers (the symbols most likely to produce the next signal).
    const trackIv = setInterval(() => {
      const hot = new Set<string>();
      for (const p of broker.getPositions()) hot.add(p.symbol);
      for (const o of broker.getPending()) hot.add(o.symbol);
      const movers = [...engine.getState()]
        .sort((a, b) => Math.abs(b.change1m) - Math.abs(a.change1m))
        .slice(0, 50);
      for (const m of movers) hot.add(m.symbol);
      micro.track([...hot]);
    }, 2000);

    let lastTickCount = 0;
    let lastSample = Date.now();
    const iv = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastSample) / 1000;
      const delta = tickCounter.current - lastTickCount;
      if (dt > 0) {
        const rate = delta / dt;
        setTickRate(rate);
        setPeakTickRate((p) => (rate > p ? rate : p));
      }
      lastTickCount = tickCounter.current;
      lastSample = now;

      broker.accrueFunding(now, marksRef.current);
      setCosts(broker.getCosts());
      setMargin(broker.getMarginSummary(marksRef.current));
      setLiquidations(broker.getLiquidations());
      setTicks(tickCounter.current);
      const state = engine.getState();
      for (const row of state) regimeRef.current.set(row.symbol, regimeOf(row.change1m));
      setBoard(state);
      setPositions(broker.getPositions());
      setClosed(broker.getClosed());
      setRealized(broker.getRealizedPnl());
      setUnrealized(broker.getUnrealizedPnl(marksRef.current));
      setMetrics(engine.getMetrics());
      setExecStats(broker.getExecutionStats());
      setPendingOrders(broker.getPending());
      setMicroMetrics(micro.getMetrics());
    }, 500);

    return () => {
      clearInterval(iv);
      clearInterval(fundingIv);
      clearInterval(matchIv);
      clearInterval(trackIv);
      engine.stop();
      micro.stop();
      microRef.current = null;
      engineRef.current = null;
      brokerRef.current = null;
    };
  }, [symbols, boot, saveOpen, saveClose]);


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
    void resetAccount({ data: { wipeHistory: false } })
      .then((res) => setEdgeReport(res.report ?? EMPTY_EDGE_REPORT))
      .catch((e) => setPersistError(e instanceof Error ? e.message : "Reset failed"));
  };
  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
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

  // Hold a screen wake lock so an unattended run isn't killed by display sleep.
  useEffect(() => {
    type WakeLock = { release: () => Promise<void> };
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<WakeLock> };
    };
    if (!nav.wakeLock) return;
    let lock: WakeLock | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await nav.wakeLock!.request("screen");
        if (cancelled) void next.release();
        else lock = next;
      } catch {
        // Denied (unsupported browser / no user gesture) — run without it.
      }
    };
    void acquire();
    const onVis = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => {});
    };
  }, []);

  // Venue is armable only when a live account probe has actually succeeded AND

  // the paper run has produced the agreed review sample of closed trades.
  const sampleReady = closed.length >= REVIEW_TRADE_TARGET;
  const liveArmed = !!liveStatus?.configured && !liveStatus?.error && sampleReady;
  const runProgress = Math.min(1, closed.length / REVIEW_TRADE_TARGET);
  const uptimeMs = metrics?.startedAt ? Date.now() - metrics.startedAt : 0;
  const lastTickAgo = metrics?.lastMessageAt
    ? Math.round((Date.now() - metrics.lastMessageAt) / 1000)
    : null;


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
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                up {formatDuration(uptimeMs)} · last tick{" "}
                <span className={lastTickAgo !== null && lastTickAgo > 30 ? "text-bear" : "text-bull"}>
                  {lastTickAgo === null ? "—" : `${lastTickAgo}s ago`}
                </span>
                {metrics && metrics.watchdogRestarts > 0
                  ? ` · ${metrics.watchdogRestarts} feed recoveries`
                  : ""}
                {metrics && metrics.stalledFeeds > 0
                  ? ` · ${metrics.stalledFeeds} stalled`
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[150px]">
              <div className="flex items-baseline justify-between font-mono text-[10px] text-muted-foreground">
                <span>REVIEW SAMPLE</span>
                <span className={sampleReady ? "text-bull" : "text-foreground"}>
                  {closed.length}/{REVIEW_TRADE_TARGET}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full rounded-full transition-all ${sampleReady ? "bg-bull" : "bg-accent"}`}
                  style={{ width: `${runProgress * 100}%` }}
                />
              </div>
            </div>

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
                if (!liveMode) {
                  if (!liveArmed) {
                    setTab("live");
                    return;
                  }
                  liveFailStreakRef.current = 0;
                  setLiveTripped(null);
                  setLiveMode(true);
                  setTab("live");
                } else {
                  setLiveMode(false);
                }
              }}
              disabled={!liveMode && !liveArmed}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                liveMode
                  ? "border-accent bg-accent/20 text-accent"
                  : liveArmed
                    ? "border-border bg-card text-muted-foreground hover:text-foreground"
                    : "cursor-not-allowed border-border bg-card text-muted-foreground opacity-50"
              }`}
              title={
                liveMode
                  ? "Disarm live trading"
                  : liveArmed
                    ? `Arm ${liveProvider} ${liveStatus?.env ?? "testnet"} live trading`
                    : !sampleReady
                      ? `Locked until ${REVIEW_TRADE_TARGET} closed paper trades (${closed.length} so far)`
                      : `${liveProvider} is not reachable — see the Live tab`
              }
            >
              {liveMode
                ? `● LIVE ${(liveStatus?.env ?? "testnet").toUpperCase()}`
                : liveArmed
                  ? "○ Paper mode · ready"
                  : !sampleReady
                    ? `○ Paper mode · ${REVIEW_TRADE_TARGET - closed.length} trades to review`
                    : "○ Paper mode · live blocked"}
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
            <Stat
              label="Margin used"
              value={formatUsd(margin.usedMargin)}
              sub={`${formatUsd(margin.availableMargin)} free · ${DEFAULT_PAPER_CONFIG.leverage}x`}
              tone={margin.availableMargin > 0 ? "neutral" : "bear"}
            />
            <Stat
              label="Margin ratio"
              value={`${(margin.marginRatio * 100).toFixed(1)}%`}
              sub={`MM ${formatUsd(margin.maintenanceMargin)}`}
              tone={margin.marginRatio >= 0.8 ? "bear" : margin.marginRatio >= 0.5 ? "neutral" : "bull"}
            />
            <Stat
              label="Liq risk"
              value={`${margin.atRisk}`}
              sub={`${liquidations} liquidated`}
              tone={margin.atRisk > 0 || liquidations > 0 ? "bear" : "bull"}
            />
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
            {(
              [
                "signals",
                "positions",
                "history",
                "board",
                "execution",
                "edge",
                "live",
                "system",
              ] as Tab[]
            ).map((t) => (

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
            <button
              onClick={signOut}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>

        <section className="rounded-lg border border-border bg-card">
          {tab === "signals" && <SignalsPanel proposals={proposals} />}
          {tab === "positions" && (
            <PositionsPanel
              positions={positions}
              marks={marksRef.current}
              margin={margin}
            />
          )}
          {tab === "history" && <HistoryPanel closed={closed} />}
          {tab === "board" && (
            <BoardPanel rows={filteredBoard} query={query} setQuery={setQuery} />
          )}
          {tab === "execution" && (
            <ExecutionPanel
              stats={execStats}
              micro={microMetrics}
              pending={pendingOrders}
              rejects={rejects}
              closed={closed}
            />
          )}

          {tab === "edge" && (
            <div className="p-3">
              <EdgePanel
                report={edgeReport}
                learned={learned}
                storedSignals={storedSignals}
                storedTrades={storedTrades}
                persistError={persistError}
                closedTrades={closed}
              />

            </div>
          )}
          {tab === "system" && (
            <SystemPanel
              metrics={metrics}
              tickRate={tickRate}
              peakTickRate={peakTickRate}
              discovery={discovery}
              paper={{
                open: positions.length,
                maxOpen: DEFAULT_PAPER_CONFIG.maxPositions,
                realized,
                unrealized,
                opens: paperOpens,
                closes: closed.length,
                lastEventAt: lastPaperEventAt,
                halted,
              }}
              live={{
                enabled: liveMode,
                provider: liveProvider === "bybit" ? "Bybit" : "Binance",
                configured: liveStatus?.configured ?? false,
                error: liveStatus?.error,
                wallet: liveStatus?.wallet,
                unrealized: liveStatus?.unrealized,
                positions: livePositions.length,
                lastUpdated: liveUpdatedAt,
              }}
            />
          )}
          {tab === "live" && (
            <LivePanel
              enabled={liveMode}
              provider={liveProvider}
              status={liveStatus}
              positions={livePositions}
              log={liveLog}
              tripped={liveTripped}
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
          Costs modelled on Bybit USDT perpetuals: 0.055% taker fee on entry and
          exit, plus funding settled every 8h (00:00 / 08:00 / 16:00 UTC) at the
          live Bybit funding rate — longs pay when positive, shorts pay when
          negative. Positions use isolated margin at{" "}
          {DEFAULT_PAPER_CONFIG.leverage}x (capped by Bybit risk-limit tiers, which
          raise the maintenance margin rate as notional grows); liquidation fires
          when the mark crosses entry × (1 ∓ 1/leverage ± MMR ± taker fee) and
          caps the loss at the position's initial margin. Session costs so far: {formatUsd(costs.fees)} fees ·{" "}
          {formatUsd(costs.funding)} funding. New entries pause if
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
  margin,
}: {
  positions: Position[];
  marks: Map<string, number>;
  margin: MarginSummary;
}) {
  return (
    <>
      <PanelHeader
        title="Open Positions"
        subtitle={`Isolated margin · IM ${formatUsd(margin.usedMargin)} · MM ${formatUsd(
          margin.maintenanceMargin,
        )} · margin ratio ${(margin.marginRatio * 100).toFixed(1)}% · liquidation simulated on mark`}
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
                <th className="px-4 py-2 text-right font-medium">Lev</th>
                <th className="px-4 py-2 text-right font-medium">IM / MM</th>
                <th className="px-4 py-2 text-right font-medium">Liq</th>
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
                const pnlPct = (pnl / p.initialMargin) * 100;
                const tone = pnl >= 0 ? "text-bull" : "text-bear";
                const liqDistance =
                  mark > 0 ? (Math.abs(mark - p.liquidationPrice) / mark) * 100 : 0;
                const liqTone =
                  liqDistance <= 2
                    ? "text-bear font-semibold"
                    : liqDistance <= 10
                      ? "text-accent"
                      : "text-muted-foreground";
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
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-muted-foreground">
                      {p.leverage}x
                    </td>
                    <td className="px-4 py-1.5 text-right font-mono text-xs tabular text-muted-foreground">
                      {formatUsd(p.initialMargin)} /{" "}
                      {formatUsd(mark * p.size * p.maintenanceMarginRate)}
                    </td>
                    <td className={`px-4 py-1.5 text-right font-mono text-xs tabular ${liqTone}`}>
                      {formatPrice(p.liquidationPrice)}
                      <span className="ml-1 text-[10px]">({liqDistance.toFixed(1)}%)</span>
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
                      : t.reason === "LIQ"
                        ? "bg-bear/30 text-bear font-semibold"
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
  tripped,
  onClose,
}: {
  enabled: boolean;
  provider: LiveProvider;
  status: LiveStatus | null;
  positions: LivePosition[];
  log: LiveLogEntry[];
  tripped: string | null;
  onClose: (symbol: string) => void;
}) {
  const providerLabel = provider === "bybit" ? "Bybit" : "Binance";
  const envLabel = (status?.env ?? "testnet").toUpperCase();
  return (
    <>
      <PanelHeader
        title={`${providerLabel} ${envLabel} — Live Orders`}
        subtitle={
          enabled
            ? `High-confidence signals are executed on the ${providerLabel} ${envLabel.toLowerCase()} futures account with attached SL/TP.`
            : "Arm live mode in the header to route high-confidence signals to real orders."
        }
        badge={enabled ? "LIVE" : "OFF"}
      />
      {tripped && (
        <div className="border-b border-border bg-bear/10 px-4 py-2">
          <p className="text-[11px] font-semibold text-bear">
            Circuit breaker tripped — live mode disarmed
          </p>
          <p className="break-all font-mono text-[11px] text-bear/80">{tripped}</p>
        </div>
      )}
      <div className="border-b border-border px-4 py-3">
        {!enabled ? (
          <>
            <p className="text-xs text-muted-foreground">
              Live mode is off. The venue is probed continuously below; the header
              button only arms once {providerLabel} answers a real account query.
            </p>
            {status && (status.error || status.message) && (
              <div className="mt-3">
                <LiveErrorPanel status={status} />
              </div>
            )}
          </>
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
                {(e.count ?? 1) > 1 && (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    ×{e.count}
                  </span>
                )}

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

