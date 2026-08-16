// The trading brain, factored out of the dashboard so it can run two ways:
// inside the browser tab (current behavior) or as a standalone headless
// process (runner/index.ts). Both drive this exact module, so there is one
// implementation of the strategy and the VPS runner can never silently
// diverge from what the dashboard preview does.
//
// Persistence is injected via `EnginePersistence` — the dashboard backs it
// with TanStack server functions (see edge.functions.ts), the runner backs
// it with a direct, signed-in @supabase/supabase-js client. Neither this
// module nor its callers know which one is in use.

import {
  SwarmEngine,
  type SwarmMetrics,
  type SymbolState,
  type TradeProposal,
} from "@/lib/swarm";
import {
  PaperBroker,
  DEFAULT_PAPER_CONFIG,
  type Position,
  type ClosedTrade,
  type ExecutionStats,
  type PendingOrder,
  type RejectRecord,
  type MarginSummary,
} from "@/lib/paper-broker";
import { MicrostructureFeed, fetchInstrumentFilters, type MicroMetrics } from "@/lib/microstructure";
import { ShadowBook, type ShadowStats } from "@/lib/shadow-book";
import { confBucket, regimeOf, type LearnedEdge, type EdgeReport } from "@/lib/edge-model";
import type {
  StoredTrade,
  SignalInput,
  OpenTradeInput,
  CloseTradeInput,
} from "@/lib/edge.functions";

export interface EnginePersistence {
  saveOpenTrade(input: OpenTradeInput): Promise<unknown>;
  saveCloseTrade(input: CloseTradeInput): Promise<{ report: EdgeReport }>;
  sendSignals(signals: SignalInput[]): Promise<void>;
  onPersistError?: (message: string) => void;
}

export interface EngineBootState {
  account: { startingBalance: number; realizedPnl: number; halted: boolean };
  open: StoredTrade[];
  closed: StoredTrade[];
}

export interface EngineSnapshot {
  board: SymbolState[];
  positions: Position[];
  closed: ClosedTrade[];
  realizedPnl: number;
  unrealizedPnl: number;
  metrics: SwarmMetrics;
  execStats: ExecutionStats;
  pendingOrders: PendingOrder[];
  microMetrics: MicroMetrics | null;
  margin: MarginSummary;
  costs: { fees: number; funding: number };
  liquidations: number;
  ticks: number;
  tickRate: number;
  halted: string | null;
  /** Counterfactual book of every proposal the engine declined to trade. */
  shadow: ShadowStats;
}

export interface EngineHooks {
  onTick?: (t: { symbol: string; price: number; time: number }) => void;
  onProposal?: (p: TradeProposal, meta: { regime: string; suppressed: boolean; executed: boolean }) => void;
  onSnapshot?: (s: EngineSnapshot) => void;
  onOpen?: (p: Position) => void;
  onClose?: (t: ClosedTrade) => void;
  onReportUpdate?: (report: EdgeReport) => void;
  onHalt?: (reason: string) => void;
  onReject?: (r: RejectRecord) => void;
  onStatus?: (s: { connected: number; total: number }) => void;
}

export interface EngineRuntimeOptions {
  symbols: string[];
  boot: EngineBootState;
  /** Read fresh on every proposal — pass a ref/getter so learned weights can update live. */
  getLearned: () => LearnedEdge;
  persistence: EnginePersistence;
  hooks?: EngineHooks;
  /** How often to emit onSnapshot, in ms. Default 500 (dashboard cadence). */
  snapshotIntervalMs?: number;
  /**
   * When true, never execute proposals locally (no opens/closes, no trade
   * persistence) — used by the dashboard when a headless runner's heartbeat
   * shows it is already trading this account, so the two never race on the
   * same positions. Ticks, board state and signal display keep working.
   */
  readOnly?: boolean;
}

export interface EngineRuntime {
  start(): void;
  stop(): void;
  getBroker(): PaperBroker;
  getEngine(): SwarmEngine;
}

function toPosition(t: StoredTrade): Position & Partial<Position> {
  return {
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
  } as Position;
}

function toClosedTrade(t: StoredTrade): ClosedTrade & Partial<ClosedTrade> {
  return {
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
  } as ClosedTrade;
}

/** Builds and wires the engine + broker + microstructure feed. Caller owns start()/stop() timing. */
export function createEngineRuntime(opts: EngineRuntimeOptions): EngineRuntime {
  const { symbols, boot, getLearned, persistence, hooks = {}, snapshotIntervalMs = 500, readOnly = false } = opts;

  const marksRef = new Map<string, number>();
  const regimeMap = new Map<string, string>();
  const signalBuffer: SignalInput[] = [];
  const tickCounterRef = { current: 0 };

  const micro = new MicrostructureFeed();
  // Zero-risk counterfactual: mirrors the paper SL/TP and fee model so that
  // declined proposals can be scored against the ones we actually took.
  const shadow = new ShadowBook({
    slPct: DEFAULT_PAPER_CONFIG.slPct,
    tpPct: DEFAULT_PAPER_CONFIG.tpPct,
    takerFeeRate: DEFAULT_PAPER_CONFIG.takerFeeRate,
    fundingRatePer8h: DEFAULT_PAPER_CONFIG.defaultFundingRate,
  });

  const broker = new PaperBroker(DEFAULT_PAPER_CONFIG, {
    onHalt: (msg) => hooks.onHalt?.(msg),
    onReject: (r) => hooks.onReject?.(r),
    onOpen: (pos) => {
      hooks.onOpen?.(pos);
      void persistence
        .saveOpenTrade({
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
        })
        .catch((e: unknown) =>
          persistence.onPersistError?.(e instanceof Error ? e.message : "Trade save failed"),
        );
    },
    onClose: (trade) => {
      hooks.onClose?.(trade);
      void persistence
        .saveCloseTrade({
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
        })
        .then((res) => hooks.onReportUpdate?.(res.report))
        .catch((e: unknown) =>
          persistence.onPersistError?.(e instanceof Error ? e.message : "Trade close save failed"),
        );
    },
  });

  broker.setMarket({
    book: (s) => micro.getBook(s),
    mark: (s) => micro.getMark(s),
    filter: (s) => micro.filter(s),
  });
  broker.setMinConfidence(getLearned().minConfidence);
  broker.hydrate({
    positions: boot.open.map(toPosition),
    closed: boot.closed
      .filter((t) => t.exitPrice !== null && t.closedAt !== null)
      .map(toClosedTrade),
    realizedPnl: boot.account.realizedPnl,
    halted: boot.account.halted,
  });

  let lastPendingSweep = 0;
  const engine = new SwarmEngine(symbols, {
    onTick: (t) => {
      tickCounterRef.current += 1;
      marksRef.set(t.symbol, t.price);
      broker.markPrice(t.symbol, t.price, t.time);
      const now = Date.now();
      if (now - lastPendingSweep > 50) {
        lastPendingSweep = now;
        broker.processPending(now);
      }
      shadow.mark(t.symbol, t.price, t.time);
      hooks.onTick?.(t);
    },
    onProposal: (p) => {
      const regime = regimeMap.get(p.symbol) ?? "unknown";
      const edge = getLearned();
      const suppressed =
        readOnly ||
        edge.suppressedSymbols.includes(p.symbol) ||
        edge.costSuppressedSymbols.includes(p.symbol);
      const before = broker.getPositions().length + broker.getPending().length;
      if (!suppressed) broker.onProposal(p, { regime });
      const executed = broker.getPositions().length + broker.getPending().length > before;
      signalBuffer.push({
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
      if (signalBuffer.length > 400) signalBuffer.splice(0, signalBuffer.length - 400);
      hooks.onProposal?.(p, { regime, suppressed, executed });
    },
    onStatus: (s) => hooks.onStatus?.(s),
  });

  let flushIv: ReturnType<typeof setInterval> | null = null;
  let fundingIv: ReturnType<typeof setInterval> | null = null;
  let matchIv: ReturnType<typeof setInterval> | null = null;
  let trackIv: ReturnType<typeof setInterval> | null = null;
  let snapshotIv: ReturnType<typeof setInterval> | null = null;
  let lastTickCount = 0;
  let lastSample = Date.now();

  const loadFunding = async () => {
    try {
      const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear");
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

  function start() {
    void fetchInstrumentFilters()
      .then((f) => micro.setFilters(f))
      .catch(() => persistence.onPersistError?.("Instrument filters unavailable — fills will be rejected"));
    micro.start();
    engine.start();

    void loadFunding();
    fundingIv = setInterval(loadFunding, 5 * 60 * 1000);
    matchIv = setInterval(() => broker.processPending(Date.now()), 100);
    trackIv = setInterval(() => {
      const hot = new Set<string>();
      for (const p of broker.getPositions()) hot.add(p.symbol);
      for (const o of broker.getPending()) hot.add(o.symbol);
      const movers = [...engine.getState()]
        .sort((a, b) => Math.abs(b.change1m) - Math.abs(a.change1m))
        .slice(0, 50);
      for (const m of movers) hot.add(m.symbol);
      micro.track([...hot]);
    }, 2000);

    flushIv = setInterval(() => {
      const batch = signalBuffer.splice(0, 200);
      if (batch.length === 0) return;
      void persistence
        .sendSignals(batch)
        .catch((e: unknown) => persistence.onPersistError?.(e instanceof Error ? e.message : "Signal ingest failed"));
    }, 8000);

    snapshotIv = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastSample) / 1000;
      const delta = tickCounterRef.current - lastTickCount;
      const tickRate = dt > 0 ? delta / dt : 0;
      lastTickCount = tickCounterRef.current;
      lastSample = now;

      broker.accrueFunding(now, marksRef);
      const state = engine.getState();
      for (const row of state) regimeMap.set(row.symbol, regimeOf(row.change1m));

      hooks.onSnapshot?.({
        board: state,
        positions: broker.getPositions(),
        closed: broker.getClosed(),
        realizedPnl: broker.getRealizedPnl(),
        unrealizedPnl: broker.getUnrealizedPnl(marksRef),
        metrics: engine.getMetrics(),
        execStats: broker.getExecutionStats(),
        pendingOrders: broker.getPending(),
        microMetrics: micro.getMetrics(),
        margin: broker.getMarginSummary(marksRef),
        costs: broker.getCosts(),
        liquidations: broker.getLiquidations(),
        ticks: tickCounterRef.current,
        tickRate,
        halted: broker.isHalted() ? "halted" : null,
      });
    }, snapshotIntervalMs);
  }

  function stop() {
    if (flushIv) clearInterval(flushIv);
    if (fundingIv) clearInterval(fundingIv);
    if (matchIv) clearInterval(matchIv);
    if (trackIv) clearInterval(trackIv);
    if (snapshotIv) clearInterval(snapshotIv);
    engine.stop();
    micro.stop();
  }

  return {
    start,
    stop,
    getBroker: () => broker,
    getEngine: () => engine,
  };
}
