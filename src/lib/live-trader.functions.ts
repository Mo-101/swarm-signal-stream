// Server-side Binance USDT-M Futures TESTNET trading.
// Signs requests with HMAC-SHA256 via Web Crypto (works on Cloudflare Workers).
// Uses testnet.binancefuture.com — never touches real funds.

import { createServerFn } from "@tanstack/react-start";

const BASE = "https://testnet.binancefuture.com";

const TESTNET_KEY_HELP =
  "Use a Binance Futures Testnet key from testnet.binancefuture.com and save only the raw key text, not a .env line or quotes.";

// ─── Signing ─────────────────────────────────────────────────────────────
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

function creds() {
  const apiKey = normalizeSecret(
    process.env.BINANCE_TESTNET_API_KEY,
    "BINANCE_TESTNET_API_KEY",
  );
  const apiSecret = normalizeSecret(
    process.env.BINANCE_TESTNET_SECRET,
    "BINANCE_TESTNET_SECRET",
  );
  if (!apiKey || !apiSecret) {
    throw new Error("Binance testnet credentials are not configured.");
  }
  if (!/^[A-Za-z0-9]{40,128}$/.test(apiKey)) {
    throw new Error(`Stored BINANCE_TESTNET_API_KEY is malformed. ${TESTNET_KEY_HELP}`);
  }
  return { apiKey, apiSecret };
}

interface BinanceErrorInfo {
  message: string;
  status: number;
  code?: number;
  reason: "key-invalid" | "signature-invalid" | "timestamp" | "permissions" | "ip" | "other";
  hint?: string;
}

function formatBinanceError(status: number, body: string): BinanceErrorInfo {
  let code: number | undefined;
  let msg = body;
  try {
    const parsed = JSON.parse(body) as { code?: number; msg?: string };
    code = parsed.code;
    if (parsed.msg) msg = parsed.msg;
  } catch {
    /* keep raw body */
  }
  let reason: BinanceErrorInfo["reason"] = "other";
  let hint: string | undefined;
  if (code === -2014 || /API-key format invalid/i.test(msg)) {
    reason = "key-invalid";
    hint = `The stored BINANCE_TESTNET_API_KEY is not a valid Binance key string. ${TESTNET_KEY_HELP}`;
  } else if (code === -1022 || /[Ss]ignature.*not valid/.test(msg)) {
    reason = "signature-invalid";
    hint =
      "Signature mismatch — the stored BINANCE_TESTNET_SECRET does not match the stored API key. Regenerate the pair at testnet.binancefuture.com and save BOTH values (key + secret) exactly as shown, with no quotes or prefixes.";
  } else if (code === -1021 || /Timestamp/i.test(msg)) {
    reason = "timestamp";
    hint = "Server clock drift — retry in a moment.";
  } else if (code === -2015 || /permission|Invalid API-key/i.test(msg)) {
    reason = "permissions";
    hint =
      "API key lacks futures trading permission or IP is not whitelisted. Enable Futures on the testnet key and remove IP restrictions.";
  } else if (/IP|whitelist/i.test(msg)) {
    reason = "ip";
    hint = "IP is not whitelisted for this API key.";
  }
  return {
    message: `Binance ${status}: ${msg}`,
    status,
    code,
    reason,
    hint,
  };
}

class BinanceError extends Error {
  info: BinanceErrorInfo;
  constructor(info: BinanceErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

async function signedRequest<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const { apiKey, apiSecret } = creds();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set("timestamp", Date.now().toString());
  qs.set("recvWindow", "5000");
  const query = qs.toString();
  const signature = await hmacSha256Hex(apiSecret, query);
  const url = `${BASE}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new BinanceError(formatBinanceError(res.status, text));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function publicRequest<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// ─── Exchange filters (cached in memory per worker) ──────────────────────
interface SymbolFilter {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}
let filterCache: Map<string, SymbolFilter> | null = null;
let filterFetchedAt = 0;

async function getFilter(symbol: string): Promise<SymbolFilter> {
  const now = Date.now();
  if (!filterCache || now - filterFetchedAt > 60 * 60 * 1000) {
    interface ExchangeInfo {
      symbols: Array<{
        symbol: string;
        pricePrecision: number;
        quantityPrecision: number;
        filters: Array<Record<string, string>>;
      }>;
    }
    const info = await publicRequest<ExchangeInfo>("/fapi/v1/exchangeInfo");
    const map = new Map<string, SymbolFilter>();
    for (const s of info.symbols) {
      const priceF = s.filters.find((f) => f.filterType === "PRICE_FILTER");
      const lotF = s.filters.find((f) => f.filterType === "LOT_SIZE");
      const notF = s.filters.find(
        (f) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL",
      );
      map.set(s.symbol, {
        symbol: s.symbol,
        tickSize: parseFloat(priceF?.tickSize ?? "0.01"),
        stepSize: parseFloat(lotF?.stepSize ?? "0.001"),
        minNotional: parseFloat(notF?.notional ?? notF?.minNotional ?? "5"),
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
      });
    }
    filterCache = map;
    filterFetchedAt = now;
  }
  const f = filterCache.get(symbol);
  if (!f) throw new Error(`${symbol} not tradable on testnet.`);
  return f;
}

function roundStep(value: number, step: number, precision: number): string {
  const rounded = Math.floor(value / step) * step;
  return rounded.toFixed(precision);
}

// ─── Server functions ────────────────────────────────────────────────────

export const getLiveStatus = createServerFn({ method: "GET" }).handler(async () => {
  const apiKey = normalizeSecret(
    process.env.BINANCE_TESTNET_API_KEY,
    "BINANCE_TESTNET_API_KEY",
  );
  const apiSecret = normalizeSecret(
    process.env.BINANCE_TESTNET_SECRET,
    "BINANCE_TESTNET_SECRET",
  );
  const diagnostics = {
    keyPresent: !!apiKey,
    secretPresent: !!apiSecret,
    keyLength: apiKey?.length ?? 0,
    secretLength: apiSecret?.length ?? 0,
    keyFormatOk: !!apiKey && /^[A-Za-z0-9]{40,128}$/.test(apiKey),
    secretFormatOk: !!apiSecret && /^[A-Za-z0-9]{40,128}$/.test(apiSecret),
  };
  if (!apiKey || !apiSecret) {
    return {
      configured: false as const,
      message: !apiKey && !apiSecret
        ? "Neither BINANCE_TESTNET_API_KEY nor BINANCE_TESTNET_SECRET is saved."
        : !apiKey
          ? "BINANCE_TESTNET_API_KEY is missing — only the secret is saved."
          : "BINANCE_TESTNET_SECRET is missing — only the key is saved.",
      diagnostics,
    };
  }
  try {
    interface Account {
      totalWalletBalance: string;
      totalUnrealizedProfit: string;
      availableBalance: string;
    }
    const acct = await signedRequest<Account>("GET", "/fapi/v2/account");
    return {
      configured: true as const,
      wallet: parseFloat(acct.totalWalletBalance),
      unrealized: parseFloat(acct.totalUnrealizedProfit),
      available: parseFloat(acct.availableBalance),
      diagnostics,
    };
  } catch (e) {
    if (e instanceof BinanceError) {
      return {
        configured: true as const,
        error: e.info.message,
        errorCode: e.info.code,
        errorReason: e.info.reason,
        hint: e.info.hint,
        diagnostics,
      };
    }
    return {
      configured: true as const,
      error: e instanceof Error ? e.message : "Failed to reach testnet.",
      diagnostics,
    };
  }
});

interface LiveOrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  notionalUsd: number;
  slPct: number; // e.g. 0.008
  tpPct: number; // e.g. 0.016
  refPrice: number;
  leverage?: number;
}

export const placeLiveTrade = createServerFn({ method: "POST" })
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
  .handler(async ({ data }) => {
    const filter = await getFilter(data.symbol);
    const qtyRaw = data.notionalUsd / data.refPrice;
    const quantity = roundStep(qtyRaw, filter.stepSize, filter.quantityPrecision);
    if (parseFloat(quantity) <= 0)
      throw new Error(`Quantity rounds to 0 (notional too small).`);
    if (parseFloat(quantity) * data.refPrice < filter.minNotional)
      throw new Error(
        `Notional ${data.notionalUsd} below min ${filter.minNotional} for ${data.symbol}.`,
      );

    // Best-effort leverage set (ignore errors — e.g. already set).
    try {
      await signedRequest("POST", "/fapi/v1/leverage", {
        symbol: data.symbol,
        leverage: data.leverage ?? 5,
      });
    } catch {
      /* ignore */
    }

    const stopSide = data.side === "BUY" ? "SELL" : "BUY";
    const slPrice =
      data.side === "BUY"
        ? data.refPrice * (1 - data.slPct)
        : data.refPrice * (1 + data.slPct);
    const tpPrice =
      data.side === "BUY"
        ? data.refPrice * (1 + data.tpPct)
        : data.refPrice * (1 - data.tpPct);
    const slStr = roundStep(slPrice, filter.tickSize, filter.pricePrecision);
    const tpStr = roundStep(tpPrice, filter.tickSize, filter.pricePrecision);

    interface OrderResp {
      orderId: number;
      avgPrice?: string;
      price?: string;
      status: string;
      executedQty: string;
    }

    const entry = await signedRequest<OrderResp>("POST", "/fapi/v1/order", {
      symbol: data.symbol,
      side: data.side,
      type: "MARKET",
      quantity,
    });

    // Attach protective orders. If either fails, roll back the entry.
    try {
      const sl = await signedRequest<OrderResp>("POST", "/fapi/v1/order", {
        symbol: data.symbol,
        side: stopSide,
        type: "STOP_MARKET",
        stopPrice: slStr,
        closePosition: "true",
        workingType: "MARK_PRICE",
        timeInForce: "GTE_GTC",
      });
      const tp = await signedRequest<OrderResp>("POST", "/fapi/v1/order", {
        symbol: data.symbol,
        side: stopSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: tpStr,
        closePosition: "true",
        workingType: "MARK_PRICE",
        timeInForce: "GTE_GTC",
      });
      return {
        ok: true as const,
        symbol: data.symbol,
        side: data.side,
        quantity,
        entryOrderId: entry.orderId,
        entryPrice: parseFloat(entry.avgPrice ?? entry.price ?? "0") || data.refPrice,
        slOrderId: sl.orderId,
        tpOrderId: tp.orderId,
        slPrice: slStr,
        tpPrice: tpStr,
        placedAt: Date.now(),
      };
    } catch (protectErr) {
      // Roll back: close the entry immediately.
      try {
        await signedRequest("POST", "/fapi/v1/order", {
          symbol: data.symbol,
          side: stopSide,
          type: "MARKET",
          quantity,
          reduceOnly: "true",
        });
      } catch {
        /* best effort */
      }
      throw new Error(
        `Protective order failed, entry closed: ${
          protectErr instanceof Error ? protectErr.message : String(protectErr)
        }`,
      );
    }
  });

export const getLivePositions = createServerFn({ method: "GET" }).handler(async () => {
  interface PositionRisk {
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    markPrice: string;
    unRealizedProfit: string;
    liquidationPrice: string;
    leverage: string;
  }
  try {
    const rows = await signedRequest<PositionRisk[]>("GET", "/fapi/v2/positionRisk");
    return rows
      .filter((r) => parseFloat(r.positionAmt) !== 0)
      .map((r) => {
        const amt = parseFloat(r.positionAmt);
        return {
          symbol: r.symbol,
          side: amt > 0 ? ("BUY" as const) : ("SELL" as const),
          size: Math.abs(amt),
          entryPrice: parseFloat(r.entryPrice),
          markPrice: parseFloat(r.markPrice),
          unrealized: parseFloat(r.unRealizedProfit),
          liquidation: parseFloat(r.liquidationPrice),
          leverage: parseFloat(r.leverage),
        };
      });
  } catch (e) {
    console.warn(
      "Unable to fetch Binance testnet positions:",
      e instanceof Error ? e.message : "Failed to fetch positions.",
    );
    return [];
  }
});

export const closeLivePosition = createServerFn({ method: "POST" })
  .inputValidator((raw: { symbol: string }) => {
    if (!raw?.symbol) throw new Error("symbol required");
    return { symbol: raw.symbol.toUpperCase() };
  })
  .handler(async ({ data }) => {
    // Look up current position size.
    interface PositionRisk {
      symbol: string;
      positionAmt: string;
    }
    const rows = await signedRequest<PositionRisk[]>("GET", "/fapi/v2/positionRisk", {
      symbol: data.symbol,
    });
    const row = rows.find((r) => r.symbol === data.symbol);
    if (!row) throw new Error("Position not found.");
    const amt = parseFloat(row.positionAmt);
    if (amt === 0) {
      // Still cancel any open SL/TP orders.
      await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: data.symbol });
      return { ok: true as const, closed: false, note: "No open position." };
    }
    const filter = await getFilter(data.symbol);
    const quantity = roundStep(
      Math.abs(amt),
      filter.stepSize,
      filter.quantityPrecision,
    );
    const side = amt > 0 ? "SELL" : "BUY";
    await signedRequest("POST", "/fapi/v1/order", {
      symbol: data.symbol,
      side,
      type: "MARKET",
      quantity,
      reduceOnly: "true",
    });
    // Cancel remaining protective orders.
    try {
      await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: data.symbol });
    } catch {
      /* ignore */
    }
    return { ok: true as const, closed: true, symbol: data.symbol };
  });
