// Server-side Bybit V5 USDT-perpetual trading.
// Signs requests with HMAC-SHA256 via Web Crypto.
// Venue is testnet by default; set BYBIT_ENV=mainnet to trade the real book.

import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/auth-middleware";

const TESTNET_BASE = "https://api-testnet.bybit.com";
const MAINNET_BASE = "https://api.bybit.com";
const RECV_WINDOW = "5000";

/** "testnet" (default) or "mainnet" — mainnet means REAL funds. */
function venue(): "testnet" | "mainnet" {
  const raw = (process.env.BYBIT_ENV ?? "").trim().toLowerCase();
  return raw === "mainnet" || raw === "live" || raw === "prod" ? "mainnet" : "testnet";
}

function baseUrl(): string {
  return venue() === "mainnet" ? MAINNET_BASE : TESTNET_BASE;
}

const KEY_HELP =
  "Use a Bybit Testnet key from testnet.bybit.com (Account > API) and save only the raw key text, not a .env line or quotes. Mainnet keys do NOT work on testnet.";


async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeSecret(raw: string | undefined, envName: string): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (value.startsWith(`${envName}=`)) value = value.slice(envName.length + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("`") && value.endsWith("`"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/\s+/g, "");
}

/** Testnet-named vars win; plain BYBIT_API_* are accepted as a fallback. */
function readCreds() {
  const apiKey =
    normalizeSecret(process.env.BYBIT_TESTNET_API_KEY, "BYBIT_TESTNET_API_KEY") ||
    normalizeSecret(process.env.BYBIT_API_KEY, "BYBIT_API_KEY");
  const apiSecret =
    normalizeSecret(process.env.BYBIT_TESTNET_SECRET, "BYBIT_TESTNET_SECRET") ||
    normalizeSecret(process.env.BYBIT_API_SECRET, "BYBIT_API_SECRET");
  return { apiKey, apiSecret };
}

function creds() {
  const { apiKey, apiSecret } = readCreds();
  if (!apiKey || !apiSecret) throw new Error("Bybit testnet credentials are not configured.");
  return { apiKey, apiSecret };
}


interface BybitErrorInfo {
  message: string;
  status: number;
  code?: number;
  reason: "key-invalid" | "signature-invalid" | "timestamp" | "permissions" | "ip" | "other";
  hint?: string;
}

function classifyBybit(retCode: number, retMsg: string): BybitErrorInfo {
  // Ref: https://bybit-exchange.github.io/docs/v5/error
  let reason: BybitErrorInfo["reason"] = "other";
  let hint: string | undefined;
  if (retCode === 10003 || retCode === 10004 || /API key.*invalid|invalid api/i.test(retMsg)) {
    reason = "key-invalid";
    hint = `Stored BYBIT_TESTNET_API_KEY is not a valid Bybit key. ${KEY_HELP}`;
    if (retCode === 10004) {
      reason = "signature-invalid";
      hint =
        "Signature mismatch — stored BYBIT_TESTNET_SECRET does not match the stored API key. Regenerate the pair at testnet.bybit.com and save BOTH values exactly as shown.";
    }
  } else if (retCode === 10002 || /timestamp/i.test(retMsg)) {
    reason = "timestamp";
    hint = "Server clock drift — retry in a moment.";
  } else if (retCode === 10005 || retCode === 10007 || /permission/i.test(retMsg)) {
    reason = "permissions";
    hint =
      "API key lacks Derivatives (Contract) trading permission. Enable Unified Trading + Contract permissions on the testnet key.";
  } else if (retCode === 10010 || /ip/i.test(retMsg)) {
    reason = "ip";
    hint = "IP is not whitelisted for this API key.";
  }
  return { message: `Bybit ${retCode}: ${retMsg}`, status: 200, code: retCode, reason, hint };
}

class BybitError extends Error {
  info: BybitErrorInfo;
  constructor(info: BybitErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

interface BybitResp<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

async function signedRequest<T = unknown>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const { apiKey, apiSecret } = creds();
  const timestamp = Date.now().toString();
  let url = `${baseUrl()}${path}`;
  let body = "";
  let payload = "";
  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const query = qs.toString();
    if (query) url += `?${query}`;
    payload = query;
  } else {
    body = JSON.stringify(params);
    payload = body;
  }
  const preSign = `${timestamp}${apiKey}${RECV_WINDOW}${payload}`;
  const signature = await hmacSha256Hex(apiSecret, preSign);
  const res = await fetch(url, {
    method,
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": signature,
      "X-BAPI-SIGN-TYPE": "2",
      "Content-Type": "application/json",
    },
    body: method === "POST" ? body : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let bybitError: BybitResp<unknown> | undefined;
    try {
      bybitError = JSON.parse(text) as BybitResp<unknown>;
    } catch {
      /* body is not JSON */
    }
    if (bybitError && typeof bybitError.retCode === "number") {
      const err = new BybitError(classifyBybit(bybitError.retCode, bybitError.retMsg));
      console.error(
        `[bybit] HTTP ${res.status} on ${path}: retCode=${bybitError.retCode}, retMsg=${bybitError.retMsg}, reason=${err.info.reason}`,
      );
      throw err;
    }
    console.error(`[bybit] HTTP ${res.status} on ${path}: no parseable retCode in response`);
    throw new BybitError({
      message: `Bybit HTTP ${res.status}: ${text}`,
      status: res.status,
      reason: "other",
    });
  }
  const parsed = JSON.parse(text) as BybitResp<T>;
  if (parsed.retCode !== 0) {
    const err = new BybitError(classifyBybit(parsed.retCode, parsed.retMsg));
    console.error(
      `[bybit] business error on ${path}: retCode=${parsed.retCode}, retMsg=${parsed.retMsg}, reason=${err.info.reason}`,
    );
    throw err;
  }
  return parsed.result;
}

// ─── Instrument filters ──────────────────────────────────────────────────
interface SymbolFilter {
  symbol: string;
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}
const filterCache = new Map<string, SymbolFilter>();

function precisionOf(step: number): number {
  if (step >= 1) return 0;
  const s = step.toString();
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

async function getFilter(symbol: string): Promise<SymbolFilter> {
  const cached = filterCache.get(symbol);
  if (cached) return cached;
  interface InstrumentsResp {
    list: Array<{
      symbol: string;
      priceFilter: { tickSize: string };
      lotSizeFilter: {
        qtyStep: string;
        minOrderQty: string;
        minNotionalValue?: string;
      };
    }>;
  }
  const r = await signedRequest<InstrumentsResp>("GET", "/v5/market/instruments-info", {
    category: "linear",
    symbol,
  });
  const info = r.list?.[0];
  if (!info) throw new Error(`${symbol} not tradable on Bybit testnet.`);
  const tickSize = parseFloat(info.priceFilter.tickSize);
  const qtyStep = parseFloat(info.lotSizeFilter.qtyStep);
  const filter: SymbolFilter = {
    symbol,
    tickSize,
    qtyStep,
    minOrderQty: parseFloat(info.lotSizeFilter.minOrderQty),
    minNotional: parseFloat(info.lotSizeFilter.minNotionalValue ?? "5"),
    pricePrecision: precisionOf(tickSize),
    quantityPrecision: precisionOf(qtyStep),
  };
  filterCache.set(symbol, filter);
  return filter;
}

function roundStep(value: number, step: number, precision: number): string {
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(precision);
}

// ─── Server functions ────────────────────────────────────────────────────
export const getBybitStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
  const { apiKey, apiSecret } = readCreds();

  const diagnostics = {
    keyPresent: !!apiKey,
    secretPresent: !!apiSecret,
    keyLength: apiKey?.length ?? 0,
    secretLength: apiSecret?.length ?? 0,
    keyFormatOk: !!apiKey && /^[A-Za-z0-9_-]{12,64}$/.test(apiKey),
    secretFormatOk: !!apiSecret && /^[A-Za-z0-9_-]{20,128}$/.test(apiSecret),
  };
  const env = venue();
  if (!apiKey || !apiSecret) {
    return {
      configured: false as const,
      env,
      message: !apiKey && !apiSecret
        ? "Neither BYBIT_TESTNET_API_KEY nor BYBIT_TESTNET_SECRET is saved."
        : !apiKey
          ? "BYBIT_TESTNET_API_KEY is missing — only the secret is saved."
          : "BYBIT_TESTNET_SECRET is missing — only the key is saved.",
      diagnostics,
    };
  }
  try {
    interface WalletResp {
      list: Array<{
        totalWalletBalance: string;
        totalAvailableBalance: string;
        totalEquity?: string;
        totalPerpUPL?: string;
      }>;
    }
    const w = await signedRequest<WalletResp>("GET", "/v5/account/wallet-balance", {
      accountType: "UNIFIED",
    });
    const row = w.list?.[0];
    const wallet = parseFloat(row?.totalWalletBalance || row?.totalEquity || "0");
    return {
      configured: true as const,
      env,
      wallet,
      unrealized: parseFloat(row?.totalPerpUPL ?? "0"),
      available: parseFloat(row?.totalAvailableBalance ?? "0"),
      diagnostics,
      ...(wallet <= 0
        ? {
            warning:
              env === "testnet"
                ? "Account balance is zero — request testnet funds at testnet.bybit.com before arming live mode."
                : "Account balance is zero — no order can be filled.",
          }
        : {}),
    };
  } catch (e) {
    const wrongVenue = await detectVenueMismatch(apiKey, apiSecret, env).catch(() => null);

    const base = {
      configured: true as const,
      env,
      diagnostics,
      ...(wrongVenue ? { wrongVenue } : {}),
    };
    if (e instanceof BybitError) {
      return {
        ...base,
        error: wrongVenue
          ? `These credentials are ${wrongVenue} keys, but the app is set to ${env}.`
          : e.info.message,
        errorCode: e.info.code,
        errorReason: wrongVenue ? ("key-invalid" as const) : e.info.reason,
        hint: wrongVenue
          ? `Create a ${env} key pair (${env === "testnet" ? "testnet.bybit.com" : "bybit.com"} > API management) and save it, or switch the venue by setting BYBIT_ENV=${wrongVenue}.`
          : e.info.hint,
      };
    }
    return {
      ...base,
      error: e instanceof Error ? e.message : `Failed to reach Bybit ${env}.`,
      ...(wrongVenue
        ? {
            hint: `These look like ${wrongVenue} credentials while the app is pointed at ${env}.`,
          }
        : {}),
    };
  }
});

/**
 * When auth fails, probe the *other* venue with the same credentials so the
 * UI can say "these are mainnet keys" instead of a generic signature error.
 */
async function detectVenueMismatch(
  apiKey: string,
  apiSecret: string,
  current: "testnet" | "mainnet",
): Promise<"testnet" | "mainnet" | null> {
  const other = current === "testnet" ? "mainnet" : "testnet";
  const host = other === "mainnet" ? MAINNET_BASE : TESTNET_BASE;
  try {
    const timestamp = Date.now().toString();
    const query = "accountType=UNIFIED";
    const signature = await hmacSha256Hex(
      apiSecret,
      `${timestamp}${apiKey}${RECV_WINDOW}${query}`,
    );
    const res = await fetch(`${host}/v5/account/wallet-balance?${query}`, {
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": signature,
        "X-BAPI-SIGN-TYPE": "2",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { retCode?: number };
    return json.retCode === 0 ? other : null;
  } catch {
    return null;
  }
}


interface LiveOrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  notionalUsd: number;
  slPct: number;
  tpPct: number;
  refPrice: number;
  leverage?: number;
}

export const placeBybitTrade = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((raw: LiveOrderInput) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid payload");
    const { symbol, side, notionalUsd, slPct, tpPct, refPrice } = raw;
    if (!symbol || (side !== "BUY" && side !== "SELL"))
      throw new Error("Invalid symbol/side");
    if (!(notionalUsd > 0) || !(refPrice > 0)) throw new Error("Invalid size");
    if (!(slPct > 0 && slPct < 0.2)) throw new Error("Invalid slPct");
    if (!(tpPct > 0 && tpPct < 0.5)) throw new Error("Invalid tpPct");
    return {
      symbol: symbol.toUpperCase(),
      side,
      notionalUsd,
      slPct,
      tpPct,
      refPrice,
      leverage: Math.max(1, Math.min(Math.floor(raw.leverage ?? 5), 20)),
    } as LiveOrderInput;
  })
  .handler(async ({ data, context }) => {
    const filter = await getFilter(data.symbol);
    const qtyRaw = data.notionalUsd / data.refPrice;
    const quantity = roundStep(qtyRaw, filter.qtyStep, filter.quantityPrecision);
    if (parseFloat(quantity) < filter.minOrderQty)
      throw new Error(
        `Quantity ${quantity} below min ${filter.minOrderQty} for ${data.symbol}.`,
      );
    if (parseFloat(quantity) * data.refPrice < filter.minNotional)
      throw new Error(
        `Notional ${data.notionalUsd} below min ${filter.minNotional} for ${data.symbol}.`,
      );

    const slPrice =
      data.side === "BUY"
        ? data.refPrice * (1 - data.slPct)
        : data.refPrice * (1 + data.slPct);
    // Exit is a trailing stop, not a fixed TP: it arms once price has moved
    // halfway to the old fixed-TP distance, then follows the peak, closing
    // only on a real retracement — lets a winner keep running instead of
    // capping every trade at the same target. tpPct still sizes both
    // distances so the caller's SL/TP ratio config carries over unchanged.
    const activationDistance = data.refPrice * data.tpPct * 0.5;
    const trailingDistanceVal = data.refPrice * data.tpPct * 0.4;
    const activePrice =
      data.side === "BUY"
        ? data.refPrice + activationDistance
        : data.refPrice - activationDistance;
    const tpPrice =
      data.side === "BUY"
        ? data.refPrice * (1 + data.tpPct)
        : data.refPrice * (1 - data.tpPct);
    const slStr = roundStep(slPrice, filter.tickSize, filter.pricePrecision);
    const tpStr = roundStep(tpPrice, filter.tickSize, filter.pricePrecision);
    const activeStr = roundStep(activePrice, filter.tickSize, filter.pricePrecision);
    const trailStr = roundStep(trailingDistanceVal, filter.tickSize, filter.pricePrecision);
    const lev = String(data.leverage ?? 5);

    // Best-effort leverage set.
    try {
      await signedRequest("POST", "/v5/position/set-leverage", {
        category: "linear",
        symbol: data.symbol,
        buyLeverage: lev,
        sellLeverage: lev,
      });
    } catch {
      /* leverage may already be set */
    }

    interface OrderResp {
      orderId: string;
      orderLinkId: string;
    }
    const entry = await signedRequest<OrderResp>("POST", "/v5/order/create", {
      category: "linear",
      symbol: data.symbol,
      side: data.side === "BUY" ? "Buy" : "Sell",
      orderType: "Market",
      qty: quantity,
      stopLoss: slStr,
      slTriggerBy: "MarkPrice",
      tpslMode: "Full",
      positionIdx: 0,
    });

    // Arm the trailing-stop exit — Bybit's own engine tracks the peak price
    // and moves the stop server-side, so this needs no polling from us.
    try {
      await signedRequest("POST", "/v5/position/trading-stop", {
        category: "linear",
        symbol: data.symbol,
        trailingStop: trailStr,
        activePrice: activeStr,
        positionIdx: 0,
      });
    } catch (e) {
      console.error(`[bybit] failed to arm trailing stop for ${data.symbol}:`, e);
    }

    const { persistLiveOpenTrade } = await import("@/lib/db/live-store.server");
    const { clientId } = await persistLiveOpenTrade(context.supabase, context.userId, {
      provider: "bybit",
      symbol: data.symbol,
      side: data.side,
      entryPrice: data.refPrice,
      size: parseFloat(quantity),
      notional: data.notionalUsd,
      stopLoss: parseFloat(slStr),
      takeProfit: parseFloat(tpStr),
      trailingActivePrice: parseFloat(activeStr),
      trailingDistance: parseFloat(trailStr),
      leverage: data.leverage,
      entryOrderId: entry.orderId,
      slOrderId: entry.orderId,
    });

    return {
      ok: true as const,
      clientId,
      symbol: data.symbol,
      side: data.side,
      quantity,
      entryOrderId: entry.orderId,
      entryPrice: data.refPrice,
      slOrderId: entry.orderId,
      slPrice: slStr,
      tpPrice: tpStr,
      activePrice: activeStr,
      trailingDistance: trailStr,
      placedAt: Date.now(),
    };
  });

export const getBybitPositions = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
  interface PositionsResp {
    list: Array<{
      symbol: string;
      side: "Buy" | "Sell" | "";
      size: string;
      avgPrice: string;
      markPrice: string;
      unrealisedPnl: string;
      liqPrice: string;
      leverage: string;
    }>;
  }
  try {
    const r = await signedRequest<PositionsResp>("GET", "/v5/position/list", {
      category: "linear",
      settleCoin: "USDT",
    });
    return r.list
      .filter((p) => parseFloat(p.size) > 0)
      .map((p) => ({
        symbol: p.symbol,
        side: p.side === "Buy" ? ("BUY" as const) : ("SELL" as const),
        size: parseFloat(p.size),
        entryPrice: parseFloat(p.avgPrice),
        markPrice: parseFloat(p.markPrice),
        unrealized: parseFloat(p.unrealisedPnl),
        liquidation: parseFloat(p.liqPrice || "0"),
        leverage: parseFloat(p.leverage),
      }));
  } catch (e) {
    console.warn(
      "Unable to fetch Bybit testnet positions:",
      e instanceof Error ? e.message : "Failed to fetch positions.",
    );
    return [];
  }
});

export const getBybitHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    // Live-trade persistence is Neon-only; without DATABASE_URL it throws.
    // Degrade to an empty book instead of a 500 that blanks the dashboard.
    let closed: Awaited<ReturnType<typeof import("@/lib/db/live-store.server").loadLiveTrades>>["closed"] = [];
    try {
      const { loadLiveTrades } = await import("@/lib/db/live-store.server");
      ({ closed } = await loadLiveTrades(context.supabase, context.userId, "bybit"));
    } catch (e) {
      console.error("[bybit] live history unavailable:", e instanceof Error ? e.message : e);
    }


    // Bybit is the source of truth for real-money executions. Protective
    // stops and trailing stops can close a position on the exchange while
    // the dashboard is closed, so those trades will never pass through our
    // local close handler. Recover them from Bybit on every history refresh
    // and merge them with the richer app-side records.
    try {
      interface ClosedPnlResp {
        list: Array<{
          symbol: string;
          orderId: string;
          side: "Buy" | "Sell";
          qty: string;
          closedSize: string;
          avgEntryPrice: string;
          avgExitPrice: string;
          cumEntryValue: string;
          closedPnl: string;
          leverage?: string;
          createdTime: string;
          updatedTime: string;
        }>;
      }

      const result = await signedRequest<ClosedPnlResp>("GET", "/v5/position/closed-pnl", {
        category: "linear",
        limit: 100,
      });
      const persistedExitIds = new Set(closed.map((trade) => trade.exitOrderId).filter(Boolean));
      const exchangeRows = (result.list ?? [])
        .filter((row) => !persistedExitIds.has(row.orderId))
        .map((row) => {
          const entryPrice = Number(row.avgEntryPrice);
          const exitPrice = Number(row.avgExitPrice);
          const size = Number(row.closedSize || row.qty);
          const notional = Number(row.cumEntryValue) || entryPrice * size;
          const pnl = Number(row.closedPnl);
          return {
            clientId: `bybit-closed-${row.orderId}`,
            provider: "bybit" as const,
            symbol: row.symbol,
            side: row.side === "Buy" ? ("BUY" as const) : ("SELL" as const),
            entryPrice,
            exitPrice,
            size,
            notional,
            stopLoss: null,
            takeProfit: null,
            leverage: row.leverage ? Number(row.leverage) : null,
            trailingActivePrice: null,
            trailingDistance: null,
            status: "closed" as const,
            pnl,
            pnlPct: notional ? (pnl / notional) * 100 : 0,
            reason: "EXCHANGE",
            entryOrderId: null,
            slOrderId: null,
            tpOrderId: null,
            exitOrderId: row.orderId,
            openedAt: Number(row.createdTime),
            closedAt: Number(row.updatedTime),
          };
        });

      return [...closed, ...exchangeRows].sort(
        (a, b) => (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt),
      );
    } catch (error) {
      console.error(
        "[bybit] closed-PnL reconciliation failed; using persisted history:",
        error instanceof Error ? error.message : error,
      );
      return closed;
    }
  });

export const closeBybitPosition = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((raw: { symbol: string }) => {
    if (!raw?.symbol) throw new Error("symbol required");
    return { symbol: raw.symbol.toUpperCase() };
  })
  .handler(async ({ data, context }) => {
    interface PositionsResp {
      list: Array<{
        symbol: string;
        side: "Buy" | "Sell" | "";
        size: string;
        avgPrice: string;
        markPrice: string;
        unrealisedPnl: string;
      }>;
    }
    const r = await signedRequest<PositionsResp>("GET", "/v5/position/list", {
      category: "linear",
      symbol: data.symbol,
    });
    const row = r.list?.find((p) => p.symbol === data.symbol);
    if (!row) throw new Error("Position not found.");
    const size = parseFloat(row.size);
    if (size === 0) return { ok: true as const, closed: false, note: "No open position." };
    const filter = await getFilter(data.symbol);
    const quantity = roundStep(size, filter.qtyStep, filter.quantityPrecision);
    const exitOrder = await signedRequest<{ orderId: string }>("POST", "/v5/order/create", {
      category: "linear",
      symbol: data.symbol,
      side: row.side === "Buy" ? "Sell" : "Buy",
      orderType: "Market",
      qty: quantity,
      reduceOnly: true,
      positionIdx: 0,
    });

    const entryPrice = parseFloat(row.avgPrice);
    const exitPrice = parseFloat(row.markPrice);
    const pnl = parseFloat(row.unrealisedPnl);
    const notional = entryPrice * size;
    const { persistLiveCloseTrade } = await import("@/lib/db/live-store.server");
    await persistLiveCloseTrade(context.supabase, context.userId, {
      provider: "bybit",
      symbol: data.symbol,
      exitPrice,
      pnl,
      pnlPct: notional ? (pnl / notional) * 100 : 0,
      reason: "MANUAL",
      exitOrderId: exitOrder.orderId,
    });

    return { ok: true as const, closed: true, symbol: data.symbol };
  });
