// The only place grid orders become Bybit requests. Keeping the translation
// here means the engine never learns exchange vocabulary, and there is exactly
// one file to audit when asking "can this place a real order?".
import type { GridOrder } from "../src/lib/futures-grid";

export type BybitOrderRequest = {
  category: "linear";
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Limit";
  qty: string;
  price: string;
  timeInForce: "PostOnly" | "GTC";
  /** Bybit orderLinkId: unique, max 36 characters. */
  orderLinkId: string;
};

/** Bybit's documented ceiling for orderLinkId. A UUID is exactly this long. */
export const MAX_ORDER_LINK_ID_LENGTH = 36;

export function toBybitGridOrder(symbol: string, order: GridOrder): BybitOrderRequest {
  if (order.clientOrderId.length > MAX_ORDER_LINK_ID_LENGTH) {
    throw new Error(
      `orderLinkId exceeds Bybit's ${MAX_ORDER_LINK_ID_LENGTH}-character limit: ` +
        `${order.clientOrderId.length} chars`,
    );
  }

  return {
    category: "linear",
    symbol,
    side: order.side,
    orderType: "Limit",
    qty: String(order.qty),
    price: String(order.price),
    // PostOnly by default: a grid sized on maker economics must not silently
    // cross the spread and pay taker fees the edge model never budgeted for.
    // Taker fallback, if ever added, belongs in an explicit strategy mode.
    timeInForce: "PostOnly",
    orderLinkId: order.clientOrderId,
  };
}

// ── Execution gate ────────────────────────────────────────────────────────

export type GridExecutionMode = "disabled" | "paper" | "testnet" | "live";

const VALID_MODES: readonly GridExecutionMode[] = ["disabled", "paper", "testnet", "live"];

/**
 * Reads FUTURES_GRID_MODE, defaulting to "paper".
 *
 * The default is deliberately the safe one: an image can ship with the grid
 * engine present and fully exercised while remaining structurally unable to
 * place an order. An unrecognised value falls back to "paper" rather than
 * failing open.
 */
export function getGridExecutionMode(): GridExecutionMode {
  const raw = process.env.FUTURES_GRID_MODE?.trim().toLowerCase();
  if (!raw) return "paper";

  if (!VALID_MODES.includes(raw as GridExecutionMode)) {
    console.warn(`[grid] unrecognised FUTURES_GRID_MODE="${raw}"; falling back to paper`);
    return "paper";
  }

  return raw as GridExecutionMode;
}

/**
 * True only when the mode explicitly permits reaching the exchange.
 * "live" is accepted by the type but intentionally not yet enabled here —
 * promoting past testnet must be a separate, deliberate change.
 */
export function canPlaceGridOrders(mode: GridExecutionMode = getGridExecutionMode()): boolean {
  return mode === "testnet";
}

/** Logs and drops an order unless the mode permits execution. Returns true if suppressed. */
export function suppressGridOrder(
  order: GridOrder,
  mode: GridExecutionMode = getGridExecutionMode(),
): boolean {
  if (canPlaceGridOrders(mode)) return false;
  console.log(`[grid] order suppressed mode=${mode} ${order.side} ${order.qty}@${order.price}`);
  return true;
}
