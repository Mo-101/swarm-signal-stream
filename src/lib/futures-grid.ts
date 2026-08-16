// ─── Futures Grid: geometry, economics and risk ────────────────────────────
// Pure model for a Bybit-style futures grid bot. Arithmetic grids space levels
// by equal price difference, geometric grids by equal ratio.
//
// This module deliberately does not talk to an exchange and does not place
// orders. It answers three questions and nothing else:
//   1. Where are the levels? (geometry)
//   2. Does a round trip between adjacent levels clear its own costs?
//      (economics — a grid whose step is thinner than fees + funding +
//      slippage is a machine for paying the exchange)
//   3. Is the position still inside its risk envelope? (risk)
//
// Order placement lives behind runner/bybit-grid.ts; the engine owns the
// state. Keeping those apart is what lets the grid be validated and persisted
// before it is ever allowed to trade.

export type GridDirection = "long" | "short" | "neutral";

export type GridType = "arithmetic" | "geometric";

export type GridOrderSide = "Buy" | "Sell";

export type GridOrderStatus = "pending" | "partially_filled" | "filled" | "cancelled" | "replaced";

export type GridLevel = {
  index: number;
  price: number;
};

export type GridOrder = {
  gridIndex: number;
  side: GridOrderSide;
  price: number;
  qty: number;
  /** Sent to Bybit as orderLinkId — must be unique and <= 36 chars. */
  clientOrderId: string;
  exchangeOrderId?: string;
  status: GridOrderStatus;
  pairedGridIndex?: number;
  createdAt: number;
  filledAt?: number;
};

export type GridEconomics = {
  makerFeeRate: number;
  takerFeeRate: number;
  estimatedSlippageBps: number;
  expectedFundingRate: number;
  /** A grid step must clear this much net edge or the grid is refused. */
  minimumNetEdgeBps: number;
};

export type GridRisk = {
  maxLeverage: number;
  /** Fraction, not percent: 0.15 = mark must stay 15% away from liquidation. */
  minLiquidationDistancePct: number;
  maxMarginUtilizationPct: number;
  minFreeMarginPct: number;
  maxOpenGridOrders: number;
  maxPositionNotionalUsd: number;
};

export type FuturesGridConfig = {
  symbol: string;
  direction: GridDirection;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  gridType: GridType;
  leverage: number;
  investmentUsd: number;
  qtyPerGrid: number;
  entryPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  trailing?: {
    enabled: boolean;
    mode: "up" | "down" | "both";
    triggerPct?: number;
    stopPrice?: number;
  };
  economics: GridEconomics;
  risk: GridRisk;
};

export type GridRuntimeState = {
  symbol: string;
  active: boolean;
  direction: GridDirection;
  markPrice: number | null;
  entryPrice: number | null;
  positionQty: number;
  positionNotionalUsd: number;
  liquidationPrice: number | null;
  marginUtilizationPct: number | null;
  freeMarginPct: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  gridProfitUsd: number;
  fundingUsd: number;
  buyOrders: number;
  sellOrders: number;
  levels: GridLevel[];
  orders: GridOrder[];
  startedAt: number;
  updatedAt: number;
  /** Set when a risk breach halted the grid, so the reason survives a restart. */
  haltReasons?: string[];
};

export type GridValidationResult = {
  ok: boolean;
  errors: string[];
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function validateGridConfig(config: FuturesGridConfig): GridValidationResult {
  const errors: string[] = [];

  if (!config.symbol?.trim()) {
    errors.push("symbol is required");
  }

  if (!finitePositive(config.lowerPrice)) {
    errors.push("lowerPrice must be > 0");
  }

  if (!finitePositive(config.upperPrice)) {
    errors.push("upperPrice must be > 0");
  }

  if (
    Number.isFinite(config.lowerPrice) &&
    Number.isFinite(config.upperPrice) &&
    config.upperPrice <= config.lowerPrice
  ) {
    errors.push("upperPrice must exceed lowerPrice");
  }

  if (!Number.isInteger(config.gridCount) || config.gridCount < 2) {
    errors.push("gridCount must be an integer >= 2");
  }

  if (!finitePositive(config.leverage)) {
    errors.push("leverage must be > 0");
  }

  if (config.leverage > config.risk.maxLeverage) {
    errors.push("leverage exceeds configured maxLeverage");
  }

  if (!finitePositive(config.investmentUsd)) {
    errors.push("investmentUsd must be > 0");
  }

  if (!finitePositive(config.qtyPerGrid)) {
    errors.push("qtyPerGrid must be > 0");
  }

  const rates = [
    config.economics.makerFeeRate,
    config.economics.takerFeeRate,
    config.economics.expectedFundingRate,
  ];

  if (rates.some((x) => !Number.isFinite(x) || x < 0)) {
    errors.push("fee/funding rates must be finite and >= 0");
  }

  if (
    !Number.isFinite(config.economics.estimatedSlippageBps) ||
    config.economics.estimatedSlippageBps < 0
  ) {
    errors.push("estimatedSlippageBps must be >= 0");
  }

  if (
    !Number.isFinite(config.economics.minimumNetEdgeBps) ||
    config.economics.minimumNetEdgeBps < 0
  ) {
    errors.push("minimumNetEdgeBps must be >= 0");
  }

  if (!finitePositive(config.risk.maxPositionNotionalUsd)) {
    errors.push("maxPositionNotionalUsd must be > 0");
  }

  return { ok: errors.length === 0, errors };
}

export function arithmeticGridLevels(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number,
): GridLevel[] {
  const step = (upperPrice - lowerPrice) / gridCount;

  return Array.from({ length: gridCount + 1 }, (_, index) => ({
    index,
    price: lowerPrice + step * index,
  }));
}

export function geometricGridLevels(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number,
): GridLevel[] {
  const ratio = Math.pow(upperPrice / lowerPrice, 1 / gridCount);

  return Array.from({ length: gridCount + 1 }, (_, index) => ({
    index,
    price: lowerPrice * Math.pow(ratio, index),
  }));
}

export function buildGridLevels(config: FuturesGridConfig): GridLevel[] {
  const validation = validateGridConfig(config);

  if (!validation.ok) {
    throw new Error(`Invalid futures grid config: ${validation.errors.join("; ")}`);
  }

  if (config.gridType === "arithmetic") {
    return arithmeticGridLevels(config.lowerPrice, config.upperPrice, config.gridCount);
  }

  return geometricGridLevels(config.lowerPrice, config.upperPrice, config.gridCount);
}

export function grossReturnBps(entryPrice: number, exitPrice: number): number {
  return ((exitPrice - entryPrice) / entryPrice) * 10_000;
}

/**
 * Cost of one grid round trip in bps.
 *
 * Defaults to maker/maker because grid orders are posted PostOnly. A taker
 * fallback must be an explicit strategy choice, not an accident — pass the
 * liquidity flags rather than letting the default understate the cost.
 */
export function expectedRoundTripCostBps(
  economics: GridEconomics,
  entryLiquidity: "maker" | "taker" = "maker",
  exitLiquidity: "maker" | "taker" = "maker",
): number {
  const entryFee = entryLiquidity === "maker" ? economics.makerFeeRate : economics.takerFeeRate;

  const exitFee = exitLiquidity === "maker" ? economics.makerFeeRate : economics.takerFeeRate;

  const feeBps = (entryFee + exitFee) * 10_000;
  const fundingBps = economics.expectedFundingRate * 10_000;
  const slippageBps = economics.estimatedSlippageBps * 2;

  return feeBps + fundingBps + slippageBps;
}

export function netGridEdgeBps(
  entryPrice: number,
  exitPrice: number,
  economics: GridEconomics,
): number {
  return grossReturnBps(entryPrice, exitPrice) - expectedRoundTripCostBps(economics);
}

/**
 * Refuse a grid whose thinnest step cannot pay for itself.
 *
 * Every adjacent pair is checked, not just one: an arithmetic grid's steps
 * shrink in bps as price rises, so the top of the range is where a grid that
 * looked profitable at the bottom starts losing money on every fill.
 */
export function assertGridEconomics(config: FuturesGridConfig): void {
  const levels = buildGridLevels(config);

  for (let i = 0; i < levels.length - 1; i += 1) {
    const edge = netGridEdgeBps(levels[i].price, levels[i + 1].price, config.economics);

    if (edge < config.economics.minimumNetEdgeBps) {
      throw new Error(
        [
          "Grid economics rejected.",
          `level=${i}`,
          `edge=${edge.toFixed(4)}bps`,
          `minimum=${config.economics.minimumNetEdgeBps.toFixed(4)}bps`,
        ].join(" "),
      );
    }
  }
}

export function liquidationDistancePct(markPrice: number, liquidationPrice: number): number {
  if (!finitePositive(markPrice) || !finitePositive(liquidationPrice)) {
    throw new Error("markPrice and liquidationPrice must be > 0");
  }

  return Math.abs(markPrice - liquidationPrice) / markPrice;
}

export function evaluateGridRisk(
  config: FuturesGridConfig,
  state: GridRuntimeState,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (state.positionNotionalUsd > config.risk.maxPositionNotionalUsd) {
    reasons.push("MAX_POSITION_NOTIONAL");
  }

  if (
    state.marginUtilizationPct !== null &&
    state.marginUtilizationPct > config.risk.maxMarginUtilizationPct
  ) {
    reasons.push("MAX_MARGIN_UTILIZATION");
  }

  if (state.freeMarginPct !== null && state.freeMarginPct < config.risk.minFreeMarginPct) {
    reasons.push("MIN_FREE_MARGIN");
  }

  if (state.markPrice !== null && state.liquidationPrice !== null) {
    const distance = liquidationDistancePct(state.markPrice, state.liquidationPrice);

    if (distance < config.risk.minLiquidationDistancePct) {
      reasons.push("LIQUIDATION_DISTANCE");
    }
  }

  if (
    state.orders.filter((order) => order.status === "pending").length >
    config.risk.maxOpenGridOrders
  ) {
    reasons.push("MAX_OPEN_GRID_ORDERS");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Bybit requires orderLinkId to be unique and at most 36 characters — a UUID
 * is exactly 36. Web Crypto rather than node:crypto: this module reaches the
 * browser bundle through engine-runtime, and a `node:crypto` import would
 * break the client build.
 */
export function newGridClientOrderId(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  // Non-secure browser contexts expose getRandomValues but not randomUUID.
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function createInitialGridState(
  config: FuturesGridConfig,
  markPrice: number,
  now = Date.now(),
): GridRuntimeState {
  if (!finitePositive(markPrice)) {
    throw new Error("markPrice must be > 0");
  }

  assertGridEconomics(config);

  const levels = buildGridLevels(config);
  const orders: GridOrder[] = [];

  for (let i = 0; i < levels.length - 1; i += 1) {
    const level = levels[i];
    const side: GridOrderSide = level.price < markPrice ? "Buy" : "Sell";

    orders.push({
      gridIndex: i,
      side,
      price: level.price,
      qty: config.qtyPerGrid,
      clientOrderId: newGridClientOrderId(),
      status: "pending",
      createdAt: now,
    });
  }

  const buyOrders = orders.filter((order) => order.side === "Buy").length;
  const sellOrders = orders.length - buyOrders;

  return {
    symbol: config.symbol,
    active: false,
    direction: config.direction,
    markPrice,
    entryPrice: null,
    positionQty: 0,
    positionNotionalUsd: 0,
    liquidationPrice: null,
    marginUtilizationPct: null,
    freeMarginPct: null,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    gridProfitUsd: 0,
    fundingUsd: 0,
    buyOrders,
    sellOrders,
    levels,
    orders,
    startedAt: now,
    updatedAt: now,
  };
}
