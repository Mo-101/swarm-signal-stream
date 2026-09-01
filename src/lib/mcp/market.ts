// Shared Binance USDT-M public market-data helpers for the MCP tools.
// Public endpoints only — no API keys, no credentials, no account access.

const FAPI = "https://fapi.binance.com";

export async function fapi<T>(path: string): Promise<T> {
  const res = await fetch(`${FAPI}${path}`);
  if (!res.ok) {
    throw new Error(`Binance public API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export interface PerpInfo {
  symbol: string;
  baseAsset: string;
  onboardDate: number;
}

export async function listPerpetuals(): Promise<PerpInfo[]> {
  const data = await fapi<{
    symbols: Array<{
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      contractType: string;
      status: string;
      onboardDate: number;
    }>;
  }>("/fapi/v1/exchangeInfo");
  return data.symbols
    .filter(
      (s) =>
        s.contractType === "PERPETUAL" &&
        s.status === "TRADING" &&
        s.quoteAsset === "USDT",
    )
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      onboardDate: s.onboardDate,
    }));
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePct: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

export async function tickers24h(): Promise<Ticker24h[]> {
  const rows = await fapi<
    Array<{
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
      highPrice: string;
      lowPrice: string;
      quoteVolume: string;
    }>
  >("/fapi/v1/ticker/24hr");
  return rows.map((r) => ({
    symbol: r.symbol,
    lastPrice: parseFloat(r.lastPrice),
    priceChangePct: parseFloat(r.priceChangePercent),
    highPrice: parseFloat(r.highPrice),
    lowPrice: parseFloat(r.lowPrice),
    quoteVolume: parseFloat(r.quoteVolume),
  }));
}

export interface Candles {
  closes: number[];
  quoteVolumes: number[];
  closeTime: number;
}

/** Recent klines for a symbol, shaped for the swarm agents. */
export async function candles(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candles> {
  const rows = await fapi<unknown[][]>(
    `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
  );
  if (rows.length === 0) throw new Error(`No candle data for ${symbol}.`);
  return {
    closes: rows.map((r) => parseFloat(String(r[4]))),
    quoteVolumes: rows.map((r) => parseFloat(String(r[7]))),
    closeTime: Number(rows[rows.length - 1][6]),
  };
}
