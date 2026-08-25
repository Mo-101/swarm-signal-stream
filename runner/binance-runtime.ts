// Binance demo (testnet) execution plane.
//
// The engine keeps trading paper exactly as it does today. This coordinator
// mirrors every v3 paper position onto the Binance USDT-M Futures Testnet and
// records the real fill next to the simulated one, so the microstructure model
// can be graded against actual fills before any real capital is involved.
//
// Invariants:
//   * Paper is the source of truth. A Binance failure never blocks a paper trade.
//   * Nothing is submitted unless BINANCE_DEMO_ENABLED is truthy, credentials
//     exist, the account probe succeeded, and the DB kill switch is armed.
//   * Sizing, stops and targets come from the broker — no second risk model.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngineRuntime } from "../src/lib/engine-runtime";
import type { Position, ClosedTrade } from "../src/lib/paper-broker";
import { STRATEGY_EPOCH } from "../src/lib/strategy-epoch";
import {
  BinanceExecutor,
  BinanceApiError,
  binanceDemoEnabled,
  readBinanceCredentials,
  slippageBps,
  type BinanceSide,
  type ExchangePosition,
} from "./binance-executor";

const RECONCILE_MS = 30_000;
const CONTROL_POLL_MS = 15_000;

export interface BinanceDemoStatus {
  configured: boolean;
  enabled: boolean;
  armed: boolean;
  ready: boolean;
  equity: number | null;
  availableBalance: number | null;
  openExchangePositions: number;
  mirroredTrades: number;
  submitFailures: number;
  avgSlippageBps: number | null;
  keySource: string | null;
  lastError: string | null;
  lastHint: string | null;
  lastProbeAt: number | null;
}

interface Mirror {
  tradeId: string;
  symbol: string;
  side: BinanceSide;
  qty: number;
  /** Bracket prices last pushed to the exchange, so we only re-place on change. */
  stopLoss: number;
  takeProfit: number;
}

export class BinanceDemoCoordinator {
  private executor: BinanceExecutor | null = null;
  private readonly mirrors = new Map<string, Mirror>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private slipSum = 0;
  private slipCount = 0;
  private reconciling = false;

  private status: BinanceDemoStatus = {
    configured: false,
    enabled: binanceDemoEnabled(),
    armed: false,
    ready: false,
    equity: null,
    availableBalance: null,
    openExchangePositions: 0,
    mirroredTrades: 0,
    submitFailures: 0,
    avgSlippageBps: null,
    keySource: null,
    lastError: null,
    lastHint: null,
    lastProbeAt: null,
  };

  constructor(
    private readonly runtime: EngineRuntime,
    private readonly supabase: SupabaseClient | null,
    private readonly userId: string,
  ) {}

  getStatus(): BinanceDemoStatus {
    return {
      ...this.status,
      avgSlippageBps: this.slipCount > 0 ? this.slipSum / this.slipCount : null,
    };
  }

  /** Never throws: a dead venue leaves the runner paper-only. */
  async start(): Promise<void> {
    const creds = readBinanceCredentials();
    this.status.configured = creds !== null;
    this.status.keySource = creds?.source ?? null;

    if (!creds) {
      console.log("[binance] no testnet credentials — paper only");
      return;
    }
    if (!this.status.enabled) {
      console.log("[binance] BINANCE_DEMO_ENABLED is off — paper only");
      return;
    }

    const executor = new BinanceExecutor(creds);
    try {
      const probe = await executor.probe();
      await executor.loadFilters();
      this.executor = executor;
      this.status.ready = true;
      this.status.equity = probe.equity;
      this.status.availableBalance = probe.availableBalance;
      this.status.lastProbeAt = Date.now();
      console.log(
        `[binance] demo armed — testnet equity $${probe.equity.toFixed(2)}, available $${probe.availableBalance.toFixed(2)}`,
      );
    } catch (error) {
      this.recordError(error);
      console.warn(`[binance] probe failed, staying paper-only: ${this.status.lastError}`);
      return;
    }

    await this.refreshControl();
    this.timers.push(setInterval(() => void this.refreshControl(), CONTROL_POLL_MS));
    this.timers.push(setInterval(() => void this.reconcile(), RECONCILE_MS));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ── Kill switch ─────────────────────────────────────────────────────────

  private async refreshControl(): Promise<void> {
    if (!this.supabase) {
      // No control plane reachable: fall back to the env flag alone.
      this.status.armed = this.status.enabled;
      return;
    }
    try {
      const { data } = await this.supabase
        .from("binance_demo_control")
        .select("armed")
        .eq("user_id", this.userId)
        .maybeSingle();
      const armed = Boolean((data as { armed?: boolean } | null)?.armed);
      if (armed !== this.status.armed) {
        console.log(`[binance] kill switch -> ${armed ? "ARMED" : "DISARMED"}`);
      }
      this.status.armed = armed;
    } catch (error) {
      console.error("[binance] control poll failed:", error instanceof Error ? error.message : error);
    }
  }

  private canSubmit(): boolean {
    return this.executor !== null && this.status.ready && this.status.enabled && this.status.armed;
  }

  // ── Engine hooks ────────────────────────────────────────────────────────

  onPaperOpen(position: Position): void {
    if (!this.canSubmit()) return;
    void this.mirrorOpen(position).catch((e) => this.recordError(e));
  }

  onPaperClose(trade: ClosedTrade): void {
    if (!this.canSubmit()) return;
    void this.mirrorClose(trade).catch((e) => this.recordError(e));
  }

  private async mirrorOpen(position: Position): Promise<void> {
    const executor = this.executor!;
    const side: BinanceSide = position.side === "BUY" ? "BUY" : "SELL";
    const normalized = executor.normalize(position.symbol, position.size, position.entryPrice);
    if (!normalized) {
      console.log(
        `[binance] skip ${position.symbol}: below testnet min notional / step size — paper only`,
      );
      return;
    }

    try {
      await executor.setLeverage(position.symbol, position.leverage);
    } catch {
      // Leverage is best-effort: the account default still produces a valid order.
    }

    const clientId = `as-${position.id}`.slice(0, 36);
    let ack;
    try {
      // Same rule the paper broker used: a maker entry rests post-only at the
      // touch, everything else crosses. Post-only rejection falls back to a
      // market order so the mirror does not silently diverge from paper.
      ack = position.makerEntry
        ? await executor
            .postOnlyLimit(position.symbol, side, normalized.qty, normalized.price, clientId)
            .catch(() => executor.marketOrder(position.symbol, side, normalized.qty, clientId))
        : await executor.marketOrder(position.symbol, side, normalized.qty, clientId);
    } catch (error) {
      this.status.submitFailures += 1;
      this.recordError(error);
      await this.logOrder({
        tradeId: position.id,
        symbol: position.symbol,
        side,
        phase: "entry",
        orderType: position.makerEntry ? "LIMIT_GTX" : "MARKET",
        requestedQty: normalized.qty,
        requestedPrice: normalized.price,
        paperPrice: position.entryPrice,
        status: "rejected",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const fill = parseFloat(ack.avgPrice ?? "0") || null;
    const filledQty = parseFloat(ack.executedQty ?? "0") || null;
    const slip = fill ? slippageBps(position.entryPrice, fill, side) : null;
    if (slip !== null) {
      this.slipSum += slip;
      this.slipCount += 1;
    }
    this.status.mirroredTrades += 1;

    await this.logOrder({
      tradeId: position.id,
      symbol: position.symbol,
      side,
      phase: "entry",
      orderType: position.makerEntry ? "LIMIT_GTX" : "MARKET",
      requestedQty: normalized.qty,
      requestedPrice: normalized.price,
      paperPrice: position.entryPrice,
      fillPrice: fill,
      fillQty: filledQty,
      slippageBps: slip,
      exchangeOrderId: String(ack.orderId),
      status: ack.status ?? "submitted",
    });

    this.mirrors.set(position.id, {
      tradeId: position.id,
      symbol: position.symbol,
      side,
      qty: normalized.qty,
      stopLoss: 0,
      takeProfit: 0,
    });

    await this.syncBrackets(position);
  }

  /** (Re-)places the protective orders whenever the broker moves them. */
  private async syncBrackets(position: Position): Promise<void> {
    const executor = this.executor;
    const mirror = this.mirrors.get(position.id);
    if (!executor || !mirror) return;
    if (mirror.stopLoss === position.stopLoss && mirror.takeProfit === position.takeProfit) return;

    const exitSide: BinanceSide = mirror.side === "BUY" ? "SELL" : "BUY";
    const filter = executor.getFilter(position.symbol);
    if (!filter) return;
    const round = (p: number) =>
      Number((Math.round(p / filter.tickSize) * filter.tickSize).toFixed(filter.pricePrecision));

    try {
      await executor.cancelAll(position.symbol);
      await executor.stopMarket(position.symbol, exitSide, round(position.stopLoss));
      await executor.takeProfitMarket(position.symbol, exitSide, round(position.takeProfit));
      mirror.stopLoss = position.stopLoss;
      mirror.takeProfit = position.takeProfit;
      await this.logOrder({
        tradeId: position.id,
        symbol: position.symbol,
        side: exitSide,
        phase: "bracket",
        orderType: "STOP_MARKET+TAKE_PROFIT_MARKET",
        requestedQty: mirror.qty,
        requestedPrice: round(position.stopLoss),
        paperPrice: position.takeProfit,
        status: "working",
      });
    } catch (error) {
      this.recordError(error);
    }
  }

  private async mirrorClose(trade: ClosedTrade): Promise<void> {
    const executor = this.executor!;
    const mirror = this.mirrors.get(trade.id);
    if (!mirror) return;
    this.mirrors.delete(trade.id);

    const exitSide: BinanceSide = mirror.side === "BUY" ? "SELL" : "BUY";
    try {
      await executor.cancelAll(mirror.symbol);
      const live = (await executor.positions()).find((p) => p.symbol === mirror.symbol);
      if (!live || Math.abs(live.qty) === 0) {
        // Already flat: a protective order filled on the exchange first.
        await this.logOrder({
          tradeId: trade.id,
          symbol: mirror.symbol,
          side: exitSide,
          phase: "exit",
          orderType: "ALREADY_FLAT",
          requestedQty: mirror.qty,
          paperPrice: trade.exitPrice,
          status: "filled",
        });
        return;
      }
      const ack = await executor.closeMarket(mirror.symbol, exitSide, Math.abs(live.qty));
      const fill = parseFloat(ack.avgPrice ?? "0") || null;
      const slip = fill ? slippageBps(trade.exitPrice, fill, exitSide) : null;
      if (slip !== null) {
        this.slipSum += slip;
        this.slipCount += 1;
      }
      await this.logOrder({
        tradeId: trade.id,
        symbol: mirror.symbol,
        side: exitSide,
        phase: "exit",
        orderType: "MARKET_REDUCE_ONLY",
        requestedQty: Math.abs(live.qty),
        paperPrice: trade.exitPrice,
        fillPrice: fill,
        fillQty: parseFloat(ack.executedQty ?? "0") || null,
        slippageBps: slip,
        exchangeOrderId: String(ack.orderId),
        status: ack.status ?? "filled",
      });
    } catch (error) {
      this.status.submitFailures += 1;
      this.recordError(error);
    }
  }

  // ── Reconciliation ──────────────────────────────────────────────────────

  /**
   * Every 30s: push bracket changes the broker made (breakeven ratchet, trail),
   * and make the exchange match the engine — close anything the engine does not
   * know about, flag anything the exchange lost.
   */
  private async reconcile(): Promise<void> {
    if (this.reconciling || !this.canSubmit()) return;
    this.reconciling = true;
    try {
      const executor = this.executor!;
      const positions = this.runtime.getBroker().getPositions();

      for (const p of positions) {
        if (this.mirrors.has(p.id)) await this.syncBrackets(p);
      }

      let exchange: ExchangePosition[] = [];
      try {
        exchange = await executor.positions();
      } catch (error) {
        this.recordError(error);
        return;
      }
      this.status.openExchangePositions = exchange.length;

      const engineSymbols = new Set(
        positions.filter((p) => this.mirrors.has(p.id)).map((p) => p.symbol),
      );

      // Orphan on the exchange: the engine has no matching position. Close it —
      // an unmanaged position has no stop the engine will ever move.
      for (const ex of exchange) {
        if (engineSymbols.has(ex.symbol)) continue;
        const side: BinanceSide = ex.qty > 0 ? "SELL" : "BUY";
        console.warn(`[binance] orphan position ${ex.symbol} qty=${ex.qty} — closing`);
        try {
          await executor.cancelAll(ex.symbol);
          await executor.closeMarket(ex.symbol, side, Math.abs(ex.qty));
          await this.logOrder({
            tradeId: `orphan-${ex.symbol}`,
            symbol: ex.symbol,
            side,
            phase: "orphan-close",
            orderType: "MARKET_REDUCE_ONLY",
            requestedQty: Math.abs(ex.qty),
            paperPrice: ex.markPrice,
            status: "filled",
          });
        } catch (error) {
          this.recordError(error);
        }
      }

      // Lost on the exchange: the engine still holds it but the venue is flat.
      const exchangeSymbols = new Set(exchange.map((e) => e.symbol));
      for (const symbol of engineSymbols) {
        if (!exchangeSymbols.has(symbol)) {
          this.status.lastError = `Engine holds ${symbol} but the testnet account is flat — a protective order likely filled there first.`;
          this.status.lastHint = "Paper is unaffected; the parity ledger records the divergence.";
        }
      }

      try {
        const probe = await executor.probe();
        this.status.equity = probe.equity;
        this.status.availableBalance = probe.availableBalance;
        this.status.lastProbeAt = Date.now();
      } catch (error) {
        this.recordError(error);
      }
    } finally {
      this.reconciling = false;
    }
  }

  // ── Parity ledger ───────────────────────────────────────────────────────

  private async logOrder(row: {
    tradeId: string;
    symbol: string;
    side: BinanceSide;
    phase: string;
    orderType: string;
    requestedQty: number;
    requestedPrice?: number | null;
    paperPrice?: number | null;
    fillPrice?: number | null;
    fillQty?: number | null;
    slippageBps?: number | null;
    exchangeOrderId?: string | null;
    status: string;
    error?: string | null;
  }): Promise<void> {
    if (!this.supabase) return;
    try {
      const { error } = await this.supabase.from("binance_demo_orders").insert({
        user_id: this.userId,
        trade_id: row.tradeId,
        symbol: row.symbol,
        side: row.side,
        phase: row.phase,
        strategy_epoch: STRATEGY_EPOCH,
        order_type: row.orderType,
        requested_qty: row.requestedQty,
        requested_price: row.requestedPrice ?? null,
        paper_price: row.paperPrice ?? null,
        fill_price: row.fillPrice ?? null,
        fill_qty: row.fillQty ?? null,
        slippage_bps: row.slippageBps ?? null,
        exchange_order_id: row.exchangeOrderId ?? null,
        status: row.status,
        error: row.error ?? null,
      });
      if (error) throw new Error(error.message);
    } catch (error) {
      console.error(
        "[binance] parity ledger write failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private recordError(error: unknown): void {
    if (error instanceof BinanceApiError) {
      this.status.lastError = error.message;
      this.status.lastHint = error.hint;
      return;
    }
    this.status.lastError = error instanceof Error ? error.message : String(error);
    this.status.lastHint = null;
  }
}
