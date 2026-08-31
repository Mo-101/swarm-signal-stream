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
  type RiskAlert,
  type FundingStats,
} from "@/lib/paper-broker";
import type { RegimeStyle } from "@/lib/regime";
import { MicrostructureFeed, fetchInstrumentFilters, type MicroMetrics } from "@/lib/microstructure";
import {
  ShadowBook,
  resolveShadowConfig,
  type ShadowBookSnapshot,
  type ShadowStats,
  type ShadowTrade,
} from "@/lib/shadow-book";
import {
  createInitialGridState,
  evaluateGridRisk,
  type FuturesGridConfig,
  type GridRuntimeState,
} from "@/lib/futures-grid";
import { confBucket, regimeOf, type LearnedEdge, type EdgeReport } from "@/lib/edge-model";
import type {
  StoredTrade,
  SignalInput,
  OpenTradeInput,
  CloseTradeInput,
  FundingEventInput,
  StoredFundingEvent,
} from "@/lib/edge.functions";
import {
  fetchFundingIntervals,
  fetchFundingTickers,
  fetchSettledFundingRates,
} from "@/lib/funding-clock";

/**
 * Shadow economics the engine always runs with: the counterfactual only means
 * something if it mirrors the paper broker's SL/TP and cost model. Exported so
 * a caller can load a persisted book under the identical terms — restore()
 * rejects any snapshot whose economics disagree.
 */
/** Floor between durable grid-state writes for one symbol, in ms. */
const GRID_SAVE_INTERVAL_MS = 5_000;

export const ENGINE_SHADOW_CONFIG = resolveShadowConfig({
  slPct: DEFAULT_PAPER_CONFIG.slPct,
  tpPct: DEFAULT_PAPER_CONFIG.tpPct,
  takerFeeRate: DEFAULT_PAPER_CONFIG.takerFeeRate,
  fundingRatePer8h: DEFAULT_PAPER_CONFIG.defaultFundingRate,
});

export interface EnginePersistence {
  saveOpenTrade(input: OpenTradeInput): Promise<unknown>;
  saveCloseTrade(input: CloseTradeInput): Promise<{ report: EdgeReport }>;
  sendSignals(signals: SignalInput[]): Promise<void>;
  /**
   * Durably record shadow trades. Optional: a caller that omits these (the
   * dashboard, which runs a throwaway observer book) keeps the shadow book
   * purely in memory. The headless runner supplies both so the counterfactual
   * evidence — and the fee/funding costs behind it — survives a restart.
   */
  saveShadowOpen?(trade: ShadowTrade): Promise<unknown>;
  saveShadowClose?(trade: ShadowTrade): Promise<unknown>;
  /**
   * Durably record one funding settlement. Optional, like the shadow writers:
   * the dashboard keeps funding in memory, the headless runner persists it so
   * a restart cannot charge the same settlement twice. The write is expected
   * to be idempotent on (symbol, side, at).
   */
  saveFundingEvent?(event: FundingEventInput): Promise<unknown>;
  /** Persist grid config + runtime state after configure and every risk update. */
  saveGridState?(config: FuturesGridConfig, state: GridRuntimeState): Promise<unknown>;
  onPersistError?: (message: string) => void;
}

export interface EngineBootState {
  account: { startingBalance: number; realizedPnl: number; halted: boolean };
  open: StoredTrade[];
  closed: StoredTrade[];
  /**
   * Funding settlements already charged, replayed into the broker's
   * idempotency set so a restart cannot charge any of them a second time.
   */
  fundingEvents?: StoredFundingEvent[];
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
  /** Funding-rate, carry and CARRY-exit telemetry. */
  funding: FundingStats;
  /** Portfolio risk-limit blocks, newest first. */
  riskAlerts: RiskAlert[];
  /** How many recent proposals fell in each detected market style. */
  regimeMix: Record<RegimeStyle, number>;
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
  /** A portfolio risk limit (slot cap, side cap, cooldown, halt) blocked a trade. */
  onRiskAlert?: (a: RiskAlert) => void;
  onStatus?: (s: { connected: number; total: number }) => void;
}

export interface EngineRuntimeOptions {
  symbols: string[];
  boot: EngineBootState;
  /** Read fresh on every proposal — pass a ref/getter so learned weights can update live. */
  getLearned: () => LearnedEdge;
  persistence: EnginePersistence;
  /**
   * Previously persisted shadow book. Restored on construction so the
   * counterfactual resumes rather than restarting its sample count at zero.
   * A snapshot whose economics no longer match the live config is rejected by
   * ShadowBook.restore() and reported through onPersistError.
   */
  shadowBoot?: ShadowBookSnapshot;
  /**
   * Previously persisted grids, restored verbatim. Restore does not re-run
   * economics validation: a grid already holding inventory must come back as
   * it was, and any breach is caught by the next updateGridRiskState.
   */
  gridBoot?: Array<{ config: FuturesGridConfig; state: GridRuntimeState }>;
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

export interface GridRiskUpdate {
  markPrice: number;
  positionQty: number;
  positionNotionalUsd: number;
  liquidationPrice: number | null;
  marginUtilizationPct: number | null;
  freeMarginPct: number | null;
  unrealizedPnlUsd: number;
  fundingUsd: number;
  now?: number;
}

export interface EngineRuntime {
  start(): void;
  stop(): void;
  getBroker(): PaperBroker;
  getEngine(): SwarmEngine;

  /**
   * Futures grid, owned by the engine the same way the shadow book is.
   * Configuring a grid validates geometry, economics and risk but does not
   * place orders — execution is gated separately in the runner.
   */
  configureGrid(config: FuturesGridConfig, markPrice: number): GridRuntimeState;
  restoreGrid(config: FuturesGridConfig, state: GridRuntimeState): void;
  /**
   * Last price seen by the live tick feed. Exposed so the grid coordinator
   * reuses the feed the engine already runs rather than opening a second one.
   */
  getMarkPrice(symbol: string): number | null;
  getGridState(symbol: string): GridRuntimeState | null;
  getGridStates(): GridRuntimeState[];
  getGridConfig(symbol: string): FuturesGridConfig | null;
  updateGridRiskState(
    symbol: string,
    update: GridRiskUpdate,
  ): { state: GridRuntimeState; risk: { ok: boolean; reasons: string[] } } | null;
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
  const {
    symbols,
    boot,
    getLearned,
    persistence,
    shadowBoot,
    gridBoot,
    hooks = {},
    snapshotIntervalMs = 500,
    readOnly = false,
  } = opts;

  const marksRef = new Map<string, number>();
  const regimeMap = new Map<string, string>();
  /** Running count of detected market styles across proposals this session. */
  const regimeMix: Record<RegimeStyle, number> = {
    trend: 0,
    meanRevert: 0,
    breakout: 0,
    chop: 0,
  };
  const signalBuffer: SignalInput[] = [];
  const tickCounterRef = { current: 0 };

  const micro = new MicrostructureFeed();
  // Zero-risk counterfactual: mirrors the paper SL/TP and fee model so that
  // declined proposals can be scored against the ones we actually took.
  const reportShadowError = (verb: string) => (e: unknown) =>
    persistence.onPersistError?.(
      e instanceof Error
        ? `Shadow ${verb} save failed: ${e.message}`
        : `Shadow ${verb} save failed`,
    );

  const shadow = new ShadowBook(ENGINE_SHADOW_CONFIG, {
    onOpen: (t) => void persistence.saveShadowOpen?.(t)?.catch(reportShadowError("open")),
    onClose: (t) => void persistence.saveShadowClose?.(t)?.catch(reportShadowError("close")),
  });

  if (shadowBoot) {
    try {
      shadow.restore(shadowBoot);
    } catch (e) {
      // A rejected snapshot must not stop the engine — it only costs history.
      persistence.onPersistError?.(
        e instanceof Error ? `Shadow restore skipped: ${e.message}` : "Shadow restore skipped",
      );
    }
  }

  const broker = new PaperBroker(DEFAULT_PAPER_CONFIG, {
    onHalt: (msg) => hooks.onHalt?.(msg),
    onReject: (r) => hooks.onReject?.(r),
    onRiskAlert: (a) => hooks.onRiskAlert?.(a),
    // Every settlement is written as it is charged, so the boundary is durable
    // before the process can die holding it only in memory.
    onFunding: (e) => {
      void persistence
        .saveFundingEvent?.({
          clientId: e.positionId,
          symbol: e.symbol,
          side: e.side,
          at: e.at,
          quantity: e.quantity,
          markPrice: e.markPrice,
          rate: e.rate,
          intervalMs: e.intervalMs,
          notional: e.notional,
          amount: e.amount,
          rateSource: e.rateSource,
        })
        .catch((err: unknown) =>
          persistence.onPersistError?.(
            err instanceof Error ? err.message : "Funding event save failed",
          ),
        );
    },
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
          makerEntry: pos.makerEntry,
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
          makerExit: trade.makerExit,
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
  // Settlements already in the ledger. Seeding these BEFORE any accrual runs
  // is what makes the boot replay safe: a boundary recorded by the previous
  // process is recognised and skipped rather than charged twice.
  if (boot.fundingEvents?.length) {
    broker.restoreFundingEvents(boot.fundingEvents);
  }

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
      // Two orthogonal axes, stored together: the detected market *style*
      // (which decided the agent gating) and the volatility bucket. The edge
      // model then learns per style×vol cell, e.g. "breakout|vol:violent".
      const volRegime = regimeMap.get(p.symbol) ?? "unknown";
      const style = p.regime?.style ?? "chop";
      regimeMix[style] = (regimeMix[style] ?? 0) + 1;
      const regime = `${style}|${volRegime}`;
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
      if (!executed) {
        shadow.record(
          p,
          readOnly
            ? "observer"
            : suppressed
              ? "suppressed"
              : p.confidence < broker.getMinConfidence()
                ? "confidence"
                : "blocked",
          regime,
        );
      }
      if (signalBuffer.length > 400) signalBuffer.splice(0, signalBuffer.length - 400);
      hooks.onProposal?.(p, { regime, suppressed, executed });
    },
    onStatus: (s) => hooks.onStatus?.(s),
  });

  let flushIv: ReturnType<typeof setInterval> | null = null;
  let fundingIv: ReturnType<typeof setInterval> | null = null;
  let fundingSpecIv: ReturnType<typeof setInterval> | null = null;
  let matchIv: ReturnType<typeof setInterval> | null = null;
  let trackIv: ReturnType<typeof setInterval> | null = null;
  let snapshotIv: ReturnType<typeof setInterval> | null = null;
  let lastTickCount = 0;
  let lastSample = Date.now();

  /**
   * Per-symbol settlement period, from instruments-info. Loaded once at start
   * and refreshed hourly — Bybit can move a contract between schedules (8h to
   * 4h or 1h), and the engine must follow rather than assume.
   */
  const loadFundingIntervals = async () => {
    try {
      const intervals = await fetchFundingIntervals();
      for (const [symbol, minutes] of intervals) {
        broker.setFundingIntervalMinutes(symbol, minutes);
      }
    } catch {
      // Fall back to the 8h assumption per symbol until the next attempt.
    }
  };

  /**
   * The exchange's own funding clock: the predicted rate AND `nextFundingTime`.
   * Nothing here computes a settlement time — Bybit is the authority, so a
   * schedule change lands automatically on the next poll.
   */
  const loadFunding = async () => {
    try {
      const rows = await fetchFundingTickers();
      const now = Date.now();
      for (const t of rows) broker.applyFundingTicker(t, now);
    } catch {
      // Keep the last known schedule and the default rate assumption.
    }
  };

  /**
   * Replace provisional charges with the rate Bybit ACTUALLY settled.
   *
   * The ticker's funding rate drifts right up to settlement, so charging at it
   * is a good estimate but not the truth. history-fund-rate publishes the
   * settled rate shortly after the boundary; this books the difference exactly
   * once and marks the settlement final. A boundary Bybit has not published
   * yet stays provisional and is retried — never guessed.
   */
  const reconcileFunding = async () => {
    const pending = broker.getProvisionalFundings();
    if (pending.length === 0) return;
    // One request per symbol, covering that symbol's whole pending span.
    const bySymbol = new Map<string, { from: number; to: number }>();
    for (const e of pending) {
      const span = bySymbol.get(e.symbol);
      if (!span) bySymbol.set(e.symbol, { from: e.at, to: e.at });
      else {
        span.from = Math.min(span.from, e.at);
        span.to = Math.max(span.to, e.at);
      }
    }
    for (const [symbol, span] of bySymbol) {
      try {
        const settled = await fetchSettledFundingRates(symbol, span.from, span.to);
        if (settled.size === 0) continue;
        for (const e of pending) {
          if (e.symbol !== symbol) continue;
          let rate = settled.get(e.at);
          if (rate === undefined) {
            // Tolerate sub-second drift between our anchor and Bybit's stamp.
            for (const [ts, r] of settled) {
              if (Math.abs(ts - e.at) <= 10_000) {
                rate = r;
                break;
              }
            }
          }
          if (rate === undefined) continue;
          const delta = broker.reconcileSettledFunding(e.symbol, e.side, e.at, rate);
          if (delta !== null) {
            void persistence
              .saveFundingEvent?.({
                clientId: e.positionId,
                symbol: e.symbol,
                side: e.side,
                at: e.at,
                quantity: e.quantity,
                markPrice: e.markPrice,
                rate,
                intervalMs: e.intervalMs,
                notional: e.notional,
                amount: e.amount + delta,
                rateSource: "settled",
              })
              .catch(() => {
                /* best-effort; the next pass retries */
              });
            if (delta !== 0) {
              console.info(
                `[funding] ${e.symbol} ${e.side} @ ${new Date(e.at).toISOString()} ` +
                  `confirmed at ${(rate * 100).toFixed(4)}% → adjusted $${delta.toFixed(4)}`,
              );
            }
          }
        }
      } catch {
        // Leave them provisional; the next pass retries.
      }
    }
  };

  /**
   * Charge settlements that happened while this process was down.
   *
   * A restarted position resumes with its persisted `lastFundingAt`
   * watermark, so the boundaries it missed are known. They are replayed at
   * their SETTLED rates from history-fund-rate — not at today's live rate,
   * and not lumped into a single N-interval charge, both of which the old
   * fixed-grid accrual did. Boundaries already recorded in the funding-event
   * table were seeded into the broker at boot and are skipped.
   */
  const recoverMissedFunding = async () => {
    const now = Date.now();
    const clock = broker.getFundingClock();
    for (const p of broker.getPositions()) {
      const missed = clock.boundariesBetween(p.symbol, p.lastFundingAt, now);
      if (missed.length === 0) continue;
      try {
        const settled = await fetchSettledFundingRates(
          p.symbol,
          missed[0],
          missed[missed.length - 1],
        );
        for (const at of missed) {
          const rate = settled.get(at);
          if (rate === undefined) continue;
          const fee = broker.replaySettledFunding(p.symbol, at, rate);
          if (fee !== null) {
            console.info(
              `[funding] replayed missed settlement ${p.symbol} ${p.side} ` +
                `@ ${new Date(at).toISOString()} at ${(rate * 100).toFixed(4)}% → $${fee.toFixed(4)}`,
            );
          }
        }
      } catch {
        // The live accrual loop picks these up at the predicted rate, and the
        // reconciliation pass corrects them once Bybit publishes.
      }
    }
  };

  function start() {
    void fetchInstrumentFilters()
      .then((f) => micro.setFilters(f))
      .catch(() => persistence.onPersistError?.("Instrument filters unavailable — fills will be rejected"));
    micro.start();
    engine.start();

    // Order matters: intervals then tickers, so the first schedule the clock
    // holds is already the exchange's own, then replay whatever settled while
    // this process was down before the live accrual loop starts.
    void loadFundingIntervals()
      .then(loadFunding)
      .then(recoverMissedFunding)
      .catch(() => {
        /* every step already degrades gracefully on its own */
      });
    fundingIv = setInterval(() => {
      void loadFunding().then(reconcileFunding);
    }, 5 * 60 * 1000);
    fundingSpecIv = setInterval(() => void loadFundingIntervals(), 60 * 60 * 1000);
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
      broker.manageOpen(now, marksRef);
      shadow.sweep(now);
      const realSamples = broker.getClosed().map((t) => ({
        confidence: t.confidence,
        netBps: t.pnlPct * 100,
        netUsd: (t.pnlPct / 100) * 1_000,
      }));
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
        funding: broker.getFundingStats(marksRef),
        riskAlerts: broker.getRiskAlerts(),
        regimeMix: { ...regimeMix },
        liquidations: broker.getLiquidations(),
        ticks: tickCounterRef.current,
        tickRate,
        halted: broker.isHalted() ? "halted" : null,
        shadow: shadow.getStats(realSamples),
      });
    }, snapshotIntervalMs);
  }

  function stop() {
    if (flushIv) clearInterval(flushIv);
    if (fundingIv) clearInterval(fundingIv);
    if (fundingSpecIv) clearInterval(fundingSpecIv);
    if (matchIv) clearInterval(matchIv);
    if (trackIv) clearInterval(trackIv);
    if (snapshotIv) clearInterval(snapshotIv);
    engine.stop();
    micro.stop();
  }

  // ── Futures grid ──────────────────────────────────────────────────────
  // Keyed by symbol to match the futures_grid_state unique (user_id, symbol),
  // so several grids can run side by side without contending on one row.
  const gridConfigs = new Map<string, FuturesGridConfig>();
  const gridStates = new Map<string, GridRuntimeState>();
  /** Last durable write per symbol, to rate-limit per-tick grid persistence. */
  const lastGridSaveAt = new Map<string, number>();

  const saveGrid = (config: FuturesGridConfig, state: GridRuntimeState) =>
    void persistence
      .saveGridState?.(config, state)
      ?.catch((e: unknown) =>
        persistence.onPersistError?.(
          e instanceof Error ? `Grid state save failed: ${e.message}` : "Grid state save failed",
        ),
      );

  for (const restored of gridBoot ?? []) {
    try {
      if (restored.config.symbol !== restored.state.symbol) {
        throw new Error("grid restore symbol mismatch");
      }
      gridConfigs.set(restored.config.symbol, restored.config);
      gridStates.set(restored.state.symbol, restored.state);
    } catch (e) {
      persistence.onPersistError?.(
        e instanceof Error ? `Grid restore skipped: ${e.message}` : "Grid restore skipped",
      );
    }
  }

  function configureGrid(config: FuturesGridConfig, markPrice: number): GridRuntimeState {
    // Throws on invalid geometry, unprofitable steps or over-limit leverage —
    // a grid that cannot pay for itself must never reach the order path.
    const state = createInitialGridState(config, markPrice);
    gridConfigs.set(config.symbol, config);
    gridStates.set(config.symbol, state);
    saveGrid(config, state);
    return structuredClone(state);
  }

  function restoreGrid(config: FuturesGridConfig, state: GridRuntimeState): void {
    if (config.symbol !== state.symbol) {
      throw new Error("grid restore symbol mismatch");
    }
    gridConfigs.set(config.symbol, config);
    gridStates.set(state.symbol, state);
  }

  function updateGridRiskState(symbol: string, update: GridRiskUpdate) {
    const config = gridConfigs.get(symbol);
    const current = gridStates.get(symbol);
    if (!config || !current) return null;

    let next: GridRuntimeState = {
      ...current,
      markPrice: update.markPrice,
      positionQty: update.positionQty,
      positionNotionalUsd: update.positionNotionalUsd,
      liquidationPrice: update.liquidationPrice,
      marginUtilizationPct: update.marginUtilizationPct,
      freeMarginPct: update.freeMarginPct,
      unrealizedPnlUsd: update.unrealizedPnlUsd,
      fundingUsd: update.fundingUsd,
      updatedAt: update.now ?? Date.now(),
    };

    const risk = evaluateGridRisk(config, next);

    // A breach halts the grid and records why, so the reason survives a
    // restart instead of the grid silently coming back up inactive.
    if (!risk.ok) {
      next = { ...next, active: false, haltReasons: risk.reasons };
    } else if (next.haltReasons) {
      const { haltReasons: _cleared, ...rest } = next;
      next = rest;
    }

    gridStates.set(symbol, next);

    // Mark-to-market runs on every tick, so persisting unconditionally here
    // fired a DB write per tick per gridded symbol — enough concurrent
    // requests to exhaust the connection and fail every one of them. The
    // in-memory state above is always current; only the durable copy is
    // rate-limited, and anything that changes the grid's disposition
    // (halting, clearing a halt, going inactive) still writes immediately.
    const dispositionChanged =
      next.active !== current.active ||
      (next.haltReasons ?? []).join("|") !== (current.haltReasons ?? []).join("|");
    const now = update.now ?? Date.now();
    const lastSave = lastGridSaveAt.get(symbol) ?? 0;
    if (dispositionChanged || now - lastSave >= GRID_SAVE_INTERVAL_MS) {
      lastGridSaveAt.set(symbol, now);
      saveGrid(config, next);
    }

    return { state: structuredClone(next), risk };
  }

  return {
    start,
    stop,
    getBroker: () => broker,
    getEngine: () => engine,
    configureGrid,
    restoreGrid,
    getMarkPrice: (symbol) => marksRef.get(symbol) ?? null,
    getGridState: (symbol) => {
      const state = gridStates.get(symbol);
      return state ? structuredClone(state) : null;
    },
    getGridStates: () => [...gridStates.values()].map((s) => structuredClone(s)),
    getGridConfig: (symbol) => {
      const config = gridConfigs.get(symbol);
      return config ? structuredClone(config) : null;
    },
    updateGridRiskState,
  };
}
