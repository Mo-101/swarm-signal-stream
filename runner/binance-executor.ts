// The only place Alpha Swarm signals become Binance USDT-M Futures Testnet
// requests. Keeping the translation here means the engine never learns
// exchange vocabulary, and there is exactly one file to audit when asking
// "can this place a real order?".
//
// Testnet only: the base host is hard-coded to testnet.binancefuture.com so a
// misconfigured env var cannot point this at mainnet.
import { createHmac } from "node:crypto";

const BASE = "https://testnet.binancefuture.com";
const RECV_WINDOW = 10_000;

export type BinanceSide = "BUY" | "SELL";

export interface BinanceCredentials {
  apiKey: string;
  secret: string;
  /** Which env var the key came from, for health reporting. */
  source: string;
}

export interface SymbolFilter {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}

export class BinanceApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number | null,
    readonly hint: string | null,
  ) {
    super(message);
    this.name = "BinanceApiError";
  }
}

// ── Credentials ───────────────────────────────────────────────────────────

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

/** Returns null (rather than throwing) when the pair is not configured. */
export function readBinanceCredentials(): BinanceCredentials | null {
  const apiKey = clean(process.env.BINANCE_TESTNET_API_KEY);
  const secret = clean(process.env.BINANCE_TESTNET_SECRET);
  if (!apiKey || !secret) return null;
  return { apiKey, secret, source: "BINANCE_TESTNET_API_KEY/BINANCE_TESTNET_SECRET" };
}

/**
 * Submission is off unless BINANCE_DEMO_ENABLED is explicitly truthy. An image
 * rollout must never start sending orders by surprise.
 */
export function binanceDemoEnabled(): boolean {
  const raw = clean(process.env.BINANCE_DEMO_ENABLED).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// ── Transport ─────────────────────────────────────────────────────────────

function describe(status: number, body: string): BinanceApiError {
  // CloudFront serves an HTML block page for region-denied requests. That is a
  // network-edge refusal, not an API error: no key or signature change fixes it.
  if (
    (status === 403 || status === 401) &&
    /cloudfront|request could not be satisfied|<html/i.test(body)
  ) {
    return new BinanceApiError(
      "Binance testnet is blocked at the network edge (CloudFront 403) from this host — the request never reached the trading API.",
      status,
      null,
      "Not a key problem. Run the runner from a host/region Binance testnet accepts.",
    );
  }

  let code: number | null = null;
  let msg = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { code?: number; msg?: string };
    if (typeof parsed.code === "number") code = parsed.code;
    if (parsed.msg) msg = parsed.msg;
  } catch {
    /* non-JSON body: keep the raw text */
  }

  let hint: string | null = null;
  if (code === -2014 || code === -2015) {
    hint =
      "API key rejected. Regenerate a Futures Testnet key at testnet.binancefuture.com, enable Futures, and clear any IP whitelist.";
  } else if (code === -1022) {
    hint = "Signature mismatch — BINANCE_TESTNET_SECRET does not match the saved API key.";
  } else if (code === -1021) {
    hint = "Timestamp outside recvWindow — the host clock is skewed. Sync NTP on the runner.";
  } else if (code === -4164 || code === -1013) {
    hint = "Order rejected by symbol filters (min notional / step size).";
  }

  return new BinanceApiError(`Binance testnet ${status}: ${msg}`, status, code, hint);
}

async function publicRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  if (!res.ok) throw describe(res.status, body);
  return JSON.parse(body) as T;
}

async function signedRequest<T>(
  creds: BinanceCredentials,
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) query.set(k, String(v));
  }
  query.set("recvWindow", String(RECV_WINDOW));
  query.set("timestamp", String(Date.now()));
  const signature = createHmac("sha256", creds.secret).update(query.toString()).digest("hex");
  query.set("signature", signature);

  const res = await fetch(`${BASE}${path}?${query.toString()}`, {
    method,
    headers: { "X-MBX-APIKEY": creds.apiKey },
  });
  const body = await res.text();
  if (!res.ok) throw describe(res.status, body);
  return (body ? JSON.parse(body) : {}) as T;
}

// ── Symbol filters ────────────────────────────────────────────────────────

interface RawExchangeInfo {
  symbols: Array<{
    symbol: string;
    contractType: string;
    status: string;
    pricePrecision: number;
    quantityPrecision: number;
    filters: Array<Record<string, string>>;
  }>;
}

/** Rounds down to the nearest multiple of `step`, avoiding float dust. */
export function roundStep(value: number, step: number, precision: number): number {
  if (!(step > 0)) return Number(value.toFixed(precision));
  const units = Math.floor(value / step + 1e-9);
  return Number((units * step).toFixed(precision));
}

export class BinanceExecutor {
  private filters = new Map<string, SymbolFilter>();
  private filtersLoadedAt = 0;

  constructor(private readonly creds: BinanceCredentials) {}

  get credentialSource(): string {
    return this.creds.source;
  }

  /** Wallet probe. Throws BinanceApiError when the venue or key is unusable. */
  async probe(): Promise<{ equity: number; availableBalance: number }> {
    const acct = await signedRequest<{
      totalWalletBalance: string;
      availableBalance: string;
    }>(this.creds, "GET", "/fapi/v2/account");
    return {
      equity: parseFloat(acct.totalWalletBalance),
      availableBalance: parseFloat(acct.availableBalance),
    };
  }

  async loadFilters(force = false): Promise<void> {
    if (!force && this.filters.size > 0 && Date.now() - this.filtersLoadedAt < 6 * 3600_000) {
      return;
    }
    const info = await publicRequest<RawExchangeInfo>("/fapi/v1/exchangeInfo");
    const next = new Map<string, SymbolFilter>();
    for (const s of info.symbols) {
      if (s.contractType !== "PERPETUAL" || s.status !== "TRADING") continue;
      const price = s.filters.find((f) => f['filterType'] === "PRICE_FILTER");
      const lot = s.filters.find((f) => f['filterType'] === "LOT_SIZE");
      const notional = s.filters.find(
        (f) => f['filterType'] === "MIN_NOTIONAL" || f['filterType'] === "NOTIONAL",
      );
      next.set(s.symbol, {
        symbol: s.symbol,
        tickSize: parseFloat(price?.['tickSize'] ?? "0"),
        stepSize: parseFloat(lot?.['stepSize'] ?? "0"),
        minQty: parseFloat(lot?.['minQty'] ?? "0"),
        minNotional: parseFloat(notional?.['notional'] ?? notional?.['minNotional'] ?? "0"),
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
      });
    }
    this.filters = next;
    this.filtersLoadedAt = Date.now();
  }

  getFilter(symbol: string): SymbolFilter | null {
    return this.filters.get(symbol) ?? null;
  }

  /**
   * Rounds a requested size/price onto the symbol's grid. Returns null when the
   * symbol is untradable here or the order would fall under min notional —
   * the caller then leaves the trade paper-only rather than sending junk.
   */
  normalize(
    symbol: string,
    qty: number,
    price: number,
  ): { qty: number; price: number; filter: SymbolFilter } | null {
    const filter = this.filters.get(symbol);
    if (!filter) return null;
    const q = roundStep(qty, filter.stepSize, filter.quantityPrecision);
    const p = roundStep(price, filter.tickSize, filter.pricePrecision);
    if (q < filter.minQty || q <= 0) return null;
    if (filter.minNotional > 0 && q * p < filter.minNotional) return null;
    return { qty: q, price: p, filter };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await signedRequest(this.creds, "POST", "/fapi/v1/leverage", {
      symbol,
      leverage: Math.max(1, Math.round(leverage)),
    });
  }

  /** Ensure this symbol cannot draw on the shared futures wallet. */
  async setIsolatedMargin(symbol: string): Promise<void> {
    try {
      await signedRequest(this.creds, "POST", "/fapi/v1/marginType", {
        symbol,
        marginType: "ISOLATED",
      });
    } catch (error) {
      // Binance returns -4046 when the requested margin type is already set.
      if (error instanceof BinanceApiError && error.code === -4046) return;
      throw error;
    }
  }

  async marketOrder(
    symbol: string,
    side: BinanceSide,
    qty: number,
    clientId?: string,
  ): Promise<OrderAck> {
    return signedRequest<OrderAck>(this.creds, "POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity: qty,
      newClientOrderId: clientId,
      newOrderRespType: "RESULT",
    });
  }

  async postOnlyLimit(
    symbol: string,
    side: BinanceSide,
    qty: number,
    price: number,
    clientId?: string,
  ): Promise<OrderAck> {
    return signedRequest<OrderAck>(this.creds, "POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "LIMIT",
      timeInForce: "GTX", // post-only: rejected rather than crossing the spread
      quantity: qty,
      price,
      newClientOrderId: clientId,
      newOrderRespType: "RESULT",
    });
  }

  async stopMarket(
    symbol: string,
    side: BinanceSide,
    stopPrice: number,
    clientId?: string,
  ): Promise<OrderAck> {
    return signedRequest<OrderAck>(this.creds, "POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "STOP_MARKET",
      stopPrice,
      closePosition: "true",
      workingType: "MARK_PRICE",
      newClientOrderId: clientId,
    });
  }

  async takeProfitMarket(
    symbol: string,
    side: BinanceSide,
    stopPrice: number,
    clientId?: string,
  ): Promise<OrderAck> {
    return signedRequest<OrderAck>(this.creds, "POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "TAKE_PROFIT_MARKET",
      stopPrice,
      closePosition: "true",
      workingType: "MARK_PRICE",
      newClientOrderId: clientId,
    });
  }

  async closeMarket(symbol: string, side: BinanceSide, qty: number): Promise<OrderAck> {
    return signedRequest<OrderAck>(this.creds, "POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity: qty,
      reduceOnly: "true",
      newOrderRespType: "RESULT",
    });
  }

  async cancelAll(symbol: string): Promise<void> {
    await signedRequest(this.creds, "DELETE", "/fapi/v1/allOpenOrders", { symbol });
  }

  async openOrders(symbol?: string): Promise<Array<{ symbol: string; orderId: number }>> {
    return signedRequest(this.creds, "GET", "/fapi/v1/openOrders", { symbol });
  }

  async positions(): Promise<ExchangePosition[]> {
    const rows = await signedRequest<
      Array<{
        symbol: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        unRealizedProfit: string;
        liquidationPrice: string;
      }>
    >(this.creds, "GET", "/fapi/v2/positionRisk");
    return rows
      .map((r) => ({
        symbol: r.symbol,
        qty: parseFloat(r.positionAmt),
        entryPrice: parseFloat(r.entryPrice),
        markPrice: parseFloat(r.markPrice),
        unrealizedPnl: parseFloat(r.unRealizedProfit),
        liquidationPrice: parseFloat(r.liquidationPrice),
      }))
      .filter((p) => Math.abs(p.qty) > 0);
  }
}

export interface OrderAck {
  orderId: number;
  clientOrderId?: string;
  avgPrice?: string;
  executedQty?: string;
  status?: string;
}

export interface ExchangePosition {
  symbol: string;
  qty: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice: number;
}

/** Signed basis-point difference between the real fill and the simulated fill. */
export function slippageBps(paperPrice: number, fillPrice: number, side: BinanceSide): number {
  if (!(paperPrice > 0) || !(fillPrice > 0)) return 0;
  const raw = ((fillPrice - paperPrice) / paperPrice) * 10_000;
  // A BUY filled above the simulated price is a cost; a SELL above it is a credit.
  return side === "BUY" ? raw : -raw;
}
