// The only place Alpha Swarm signals become Bybit V5 USDT-perpetual requests.
// Keeping the translation here means the engine never learns exchange
// vocabulary, and there is exactly one file to audit when asking "can this
// place a real order?".
//
// Testnet only: the base host is hard-coded to api-testnet.bybit.com so a
// misconfigured env var cannot point this at mainnet.
import { createHmac } from "node:crypto";

const BASE = "https://api-testnet.bybit.com";
const RECV_WINDOW = 10_000;

export type BybitSide = "Buy" | "Sell";

export interface BybitCredentials {
  apiKey: string;
  secret: string;
  /** Which env var pair the key came from, for health reporting. */
  source: string;
}

export interface BybitInstrument {
  symbol: string;
  tickSize: number;
  qtyStep: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
  pricePrecision: number;
  qtyPrecision: number;
  maxLeverage: number;
}

export class BybitApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number | null,
    readonly hint: string | null,
  ) {
    super(message);
    this.name = "BybitApiError";
  }
}

// ── Credentials ───────────────────────────────────────────────────────────

function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["'`]|["'`]$/g, "");
}

/**
 * Returns null (rather than throwing) when no pair is configured. The testnet
 * pair wins: mainnet keys 401 against the testnet host, so falling back to
 * BYBIT_API_* is only useful when the operator has no dedicated testnet pair.
 */
export function readBybitCredentials(): BybitCredentials | null {
  const tKey = clean(process.env.BYBIT_TESTNET_API_KEY);
  const tSecret = clean(process.env.BYBIT_TESTNET_SECRET);
  if (tKey && tSecret) {
    return { apiKey: tKey, secret: tSecret, source: "BYBIT_TESTNET_API_KEY/BYBIT_TESTNET_SECRET" };
  }
  const key = clean(process.env.BYBIT_API_KEY);
  const secret = clean(process.env.BYBIT_API_SECRET);
  if (key && secret) {
    return { apiKey: key, secret, source: "BYBIT_API_KEY/BYBIT_API_SECRET" };
  }
  return null;
}

/**
 * Submission is off unless BYBIT_DEMO_ENABLED is explicitly truthy. An image
 * rollout must never start sending orders by surprise.
 */
export function bybitDemoEnabled(): boolean {
  const raw = clean(process.env.BYBIT_DEMO_ENABLED).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// ── Transport ─────────────────────────────────────────────────────────────

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

function hintFor(code: number | null, msg: string): string | null {
  switch (code) {
    case 10003:
    case 10004:
      return "API key or signature rejected. Create a key at testnet.bybit.com (Account > API), enable Unified Trading / Contract orders, and clear any IP whitelist.";
    case 10005:
      return "Key lacks permission — the testnet key needs Unified Trading (orders + positions) permission.";
    case 10002:
      return "Timestamp outside recvWindow — the host clock is skewed. Sync NTP on the runner.";
    case 110007:
    case 110012:
      return "Insufficient testnet balance — fund the account from testnet.bybit.com (Assets > Request test coins).";
    case 110017:
    case 110043:
      return "Position/leverage state already matches the request — safe to ignore.";
    case 110094:
    case 170131:
      return "Order below the symbol's minimum quantity or notional.";
    default:
      return /permission|api key/i.test(msg)
        ? "Check the testnet key's permissions and IP whitelist."
        : null;
  }
}

function envelopeError(status: number, body: string): BybitApiError {
  let code: number | null = null;
  let msg = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { retCode?: number; retMsg?: string };
    if (typeof parsed.retCode === "number") code = parsed.retCode;
    if (parsed.retMsg) msg = parsed.retMsg;
  } catch {
    /* non-JSON body (CDN error page etc.): keep the raw text */
  }
  return new BybitApiError(`Bybit testnet ${status}: ${msg}`, status, code, hintFor(code, msg));
}

async function publicRequest<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  if (!res.ok) throw envelopeError(res.status, body);
  const env = JSON.parse(body) as BybitEnvelope<T>;
  if (env.retCode !== 0) throw envelopeError(200, body);
  return env.result;
}

async function signedRequest<T>(
  creds: BybitCredentials,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const timestamp = String(Date.now());
  let url = `${BASE}${path}`;
  let payload = "";

  if (method === "GET") {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) query.set(k, String(v));
    }
    payload = query.toString();
    if (payload) url += `?${payload}`;
  } else {
    const clean_: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) clean_[k] = String(v);
    }
    payload = JSON.stringify(clean_);
  }

  // V5 signature: timestamp + apiKey + recvWindow + (queryString | rawBody)
  const sign = createHmac("sha256", creds.secret)
    .update(timestamp + creds.apiKey + RECV_WINDOW + payload)
    .digest("hex");

  const res = await fetch(url, {
    method,
    headers: {
      "X-BAPI-API-KEY": creds.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": String(RECV_WINDOW),
      "X-BAPI-SIGN": sign,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: payload } : {}),
  });
  const body = await res.text();
  if (!res.ok) throw envelopeError(res.status, body);
  const env = JSON.parse(body) as BybitEnvelope<T>;
  // Bybit reports business errors inside a 200 response — treat them as errors.
  if (env.retCode !== 0) throw envelopeError(200, body);
  return env.result;
}

// ── Rounding ──────────────────────────────────────────────────────────────

function decimalsOf(step: number): number {
  if (!(step > 0)) return 8;
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Rounds down to the nearest multiple of `step`, avoiding float dust. */
export function roundStep(value: number, step: number, precision: number): number {
  if (!(step > 0)) return Number(value.toFixed(precision));
  const units = Math.floor(value / step + 1e-9);
  return Number((units * step).toFixed(precision));
}

// ── Executor ──────────────────────────────────────────────────────────────

interface RawInstruments {
  nextPageCursor?: string;
  list: Array<{
    symbol: string;
    status: string;
    contractType: string;
    quoteCoin: string;
    leverageFilter?: { maxLeverage?: string };
    priceFilter?: { tickSize?: string };
    lotSizeFilter?: {
      qtyStep?: string;
      minOrderQty?: string;
      maxOrderQty?: string;
      minNotionalValue?: string;
    };
  }>;
}

export interface BybitOrderAck {
  orderId: string;
  orderLinkId: string;
}

export interface BybitFill {
  orderId: string;
  status: string;
  avgPrice: number | null;
  filledQty: number | null;
}

export interface BybitExchangePosition {
  symbol: string;
  /** Signed: positive is long, negative is short. */
  qty: number;
  side: BybitSide | "None";
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice: number | null;
}

export class BybitExecutor {
  private instruments = new Map<string, BybitInstrument>();
  private loadedAt = 0;

  constructor(private readonly creds: BybitCredentials) {}

  get credentialSource(): string {
    return this.creds.source;
  }

  /** Wallet probe. Throws BybitApiError when the venue or key is unusable. */
  async probe(): Promise<{ equity: number; available: number }> {
    const result = await signedRequest<{
      list: Array<{
        totalEquity?: string;
        totalAvailableBalance?: string;
        coin?: Array<{ coin: string; equity?: string; availableToWithdraw?: string }>;
      }>;
    }>(this.creds, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });

    const acct = result.list?.[0];
    if (!acct) return { equity: 0, available: 0 };
    const usdt = acct.coin?.find((c) => c.coin === "USDT");
    return {
      equity: parseFloat(acct.totalEquity ?? usdt?.equity ?? "0") || 0,
      available:
        parseFloat(acct.totalAvailableBalance ?? usdt?.availableToWithdraw ?? "0") || 0,
    };
  }

  async loadInstruments(force = false): Promise<void> {
    if (!force && this.instruments.size > 0 && Date.now() - this.loadedAt < 6 * 3600_000) return;

    const next = new Map<string, BybitInstrument>();
    let cursor: string | undefined;
    do {
      const page: RawInstruments = await publicRequest<RawInstruments>(
        `/v5/market/instruments-info?category=linear&limit=1000` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
      );
      for (const i of page.list ?? []) {
        if (i.status !== "Trading" || i.quoteCoin !== "USDT") continue;
        if (i.contractType && i.contractType !== "LinearPerpetual") continue;
        const tickSize = parseFloat(i.priceFilter?.tickSize ?? "0");
        const qtyStep = parseFloat(i.lotSizeFilter?.qtyStep ?? "0");
        next.set(i.symbol, {
          symbol: i.symbol,
          tickSize,
          qtyStep,
          minQty: parseFloat(i.lotSizeFilter?.minOrderQty ?? "0"),
          maxQty: parseFloat(i.lotSizeFilter?.maxOrderQty ?? "0") || Number.POSITIVE_INFINITY,
          minNotional: parseFloat(i.lotSizeFilter?.minNotionalValue ?? "0"),
          pricePrecision: decimalsOf(tickSize),
          qtyPrecision: decimalsOf(qtyStep),
          maxLeverage: parseFloat(i.leverageFilter?.maxLeverage ?? "0") || 10,
        });
      }
      cursor = page.nextPageCursor || undefined;
    } while (cursor);

    this.instruments = next;
    this.loadedAt = Date.now();
  }

  get instrumentCount(): number {
    return this.instruments.size;
  }

  getInstrument(symbol: string): BybitInstrument | null {
    return this.instruments.get(symbol) ?? null;
  }

  /**
   * Rounds a requested size/price onto the symbol's grid. Returns null when the
   * symbol is untradable here or the order would fall under min qty/notional —
   * the caller then leaves the trade paper-only rather than sending junk.
   */
  normalize(
    symbol: string,
    qty: number,
    price: number,
  ): { qty: number; price: number; instrument: BybitInstrument } | null {
    const instrument = this.instruments.get(symbol);
    if (!instrument) return null;
    const q = Math.min(
      roundStep(qty, instrument.qtyStep, instrument.qtyPrecision),
      instrument.maxQty,
    );
    const p = roundStep(price, instrument.tickSize, instrument.pricePrecision);
    if (!(q > 0) || q < instrument.minQty) return null;
    if (instrument.minNotional > 0 && q * p < instrument.minNotional) return null;
    return { qty: q, price: p, instrument };
  }

  /** Rounds a protective price onto the tick grid (nearest, not floor). */
  roundPrice(symbol: string, price: number): number | null {
    const i = this.instruments.get(symbol);
    if (!i || !(i.tickSize > 0)) return null;
    return Number((Math.round(price / i.tickSize) * i.tickSize).toFixed(i.pricePrecision));
  }

  /** Ensure this symbol cannot draw on the shared wallet, and set leverage. */
  async setIsolatedLeverage(symbol: string, leverage: number): Promise<void> {
    const instrument = this.instruments.get(symbol);
    const lev = String(
      Math.max(1, Math.min(Math.round(leverage), Math.floor(instrument?.maxLeverage ?? 10))),
    );
    try {
      await signedRequest(this.creds, "POST", "/v5/position/switch-isolated", {
        category: "linear",
        symbol,
        tradeMode: 1,
        buyLeverage: lev,
        sellLeverage: lev,
      });
    } catch (error) {
      // 110026: margin mode already isolated. Unified accounts may refuse the
      // switch entirely (110025 etc.) — leverage is still worth setting.
      if (!(error instanceof BybitApiError)) throw error;
    }
    try {
      await signedRequest(this.creds, "POST", "/v5/position/set-leverage", {
        category: "linear",
        symbol,
        buyLeverage: lev,
        sellLeverage: lev,
      });
    } catch (error) {
      // 110043: leverage not modified.
      if (error instanceof BybitApiError && error.code === 110043) return;
      throw error;
    }
  }

  async marketOrder(
    symbol: string,
    side: BybitSide,
    qty: number,
    orderLinkId?: string,
  ): Promise<BybitOrderAck> {
    return signedRequest<BybitOrderAck>(this.creds, "POST", "/v5/order/create", {
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: String(qty),
      timeInForce: "IOC",
      orderLinkId,
      positionIdx: 0,
    });
  }

  async postOnlyLimit(
    symbol: string,
    side: BybitSide,
    qty: number,
    price: number,
    orderLinkId?: string,
  ): Promise<BybitOrderAck> {
    return signedRequest<BybitOrderAck>(this.creds, "POST", "/v5/order/create", {
      category: "linear",
      symbol,
      side,
      orderType: "Limit",
      qty: String(qty),
      price: String(price),
      // PostOnly: rejected rather than crossing the spread, matching the
      // paper broker's maker-entry economics.
      timeInForce: "PostOnly",
      orderLinkId,
      positionIdx: 0,
    });
  }

  async closeMarket(symbol: string, side: BybitSide, qty: number): Promise<BybitOrderAck> {
    return signedRequest<BybitOrderAck>(this.creds, "POST", "/v5/order/create", {
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: String(qty),
      timeInForce: "IOC",
      reduceOnly: true,
      positionIdx: 0,
    });
  }

  /**
   * Position-attached stop-loss / take-profit. Bybit manages these server-side,
   * so a runner restart cannot leave a position unprotected.
   */
  async setTradingStop(symbol: string, stopLoss: number, takeProfit: number): Promise<void> {
    await signedRequest(this.creds, "POST", "/v5/position/trading-stop", {
      category: "linear",
      symbol,
      positionIdx: 0,
      tpslMode: "Full",
      stopLoss: String(stopLoss),
      takeProfit: String(takeProfit),
      slTriggerBy: "MarkPrice",
      tpTriggerBy: "MarkPrice",
    });
  }

  async cancelAll(symbol: string): Promise<void> {
    try {
      await signedRequest(this.creds, "POST", "/v5/order/cancel-all", {
        category: "linear",
        symbol,
      });
    } catch (error) {
      // 110001: nothing to cancel. Not a failure.
      if (error instanceof BybitApiError && error.code === 110001) return;
      throw error;
    }
  }

  /**
   * Fill detail for a submitted order. Bybit's create response carries no fill
   * price, so we read it back — realtime first (still open/just filled), then
   * history (already settled out of the realtime set).
   */
  async getFill(symbol: string, orderId: string): Promise<BybitFill> {
    const read = async (path: string): Promise<BybitFill | null> => {
      const result = await signedRequest<{
        list: Array<{
          orderId: string;
          orderStatus: string;
          avgPrice?: string;
          cumExecQty?: string;
        }>;
      }>(this.creds, "GET", path, { category: "linear", symbol, orderId });
      const row = result.list?.[0];
      if (!row) return null;
      return {
        orderId: row.orderId,
        status: row.orderStatus,
        avgPrice: parseFloat(row.avgPrice ?? "0") || null,
        filledQty: parseFloat(row.cumExecQty ?? "0") || null,
      };
    };

    const realtime = await read("/v5/order/realtime").catch(() => null);
    if (realtime?.avgPrice) return realtime;
    const history = await read("/v5/order/history").catch(() => null);
    return (
      history ?? realtime ?? { orderId, status: "Unknown", avgPrice: null, filledQty: null }
    );
  }

  async positions(): Promise<BybitExchangePosition[]> {
    const result = await signedRequest<{
      list: Array<{
        symbol: string;
        side: string;
        size: string;
        avgPrice?: string;
        markPrice?: string;
        unrealisedPnl?: string;
        liqPrice?: string;
      }>;
    }>(this.creds, "GET", "/v5/position/list", { category: "linear", settleCoin: "USDT" });

    return (result.list ?? [])
      .map((p) => {
        const size = parseFloat(p.size ?? "0") || 0;
        const side = p.side === "Buy" ? "Buy" : p.side === "Sell" ? "Sell" : "None";
        return {
          symbol: p.symbol,
          qty: side === "Sell" ? -size : size,
          side: side as BybitSide | "None",
          entryPrice: parseFloat(p.avgPrice ?? "0") || 0,
          markPrice: parseFloat(p.markPrice ?? "0") || 0,
          unrealizedPnl: parseFloat(p.unrealisedPnl ?? "0") || 0,
          liquidationPrice: parseFloat(p.liqPrice ?? "") || null,
        };
      })
      .filter((p) => Math.abs(p.qty) > 0);
  }
}

/** Signed basis-point difference between the real fill and the simulated fill. */
export function slippageBps(paperPrice: number, fillPrice: number, side: BybitSide): number {
  if (!(paperPrice > 0) || !(fillPrice > 0)) return 0;
  const raw = ((fillPrice - paperPrice) / paperPrice) * 10_000;
  // A Buy filled above the simulated price is a cost; a Sell above it is a credit.
  return side === "Buy" ? raw : -raw;
}
