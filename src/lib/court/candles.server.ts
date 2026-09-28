// Public Bybit 1-minute candles for the court's replays, fetched robustly.
//
// - Retries transient failures (network errors, timeouts, HTTP 429/5xx, Bybit
//   rate-limit codes) with exponential backoff. Permanent errors (unknown
//   symbol, bad params) fail fast.
// - Caches whole UTC days on disk once a day is fully closed. Closed candles
//   never change, so repeat replays and the runner's 6-hourly sessions only
//   download the new day instead of weeks of history.
//
// Server/runner only (network + filesystem).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "./replay";

const M = 60_000;
const DAY = 86_400_000;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface CandleSourceOptions {
  /** Directory for cached closed days; null disables the cache. */
  cacheDir?: string | null;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Delay between requests, ms (public rate-limit courtesy). */
  pauseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** Test hook: replaces setTimeout-based sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

class PermanentError extends Error {}

const RETRY_CODES = new Set([10006, 10016, 10018]); // rate limit, server busy, IP limit

async function fetchPage(
  symbol: string,
  start: number,
  end: number,
  o: Required<Omit<CandleSourceOptions, "cacheDir">>,
): Promise<Candle[]> {
  // COURT_KLINE_BASE: point at a mirror or a local test server; defaults to Bybit.
  const base = (process.env.COURT_KLINE_BASE ?? "https://api.bybit.com").replace(/\/$/, "");
  const u = `${base}/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${start}&end=${end}&limit=1000`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < o.maxAttempts; attempt++) {
    if (attempt) await o.sleep(o.baseBackoffMs * 2 ** (attempt - 1));
    try {
      const res = await o.fetchImpl(u, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`kline HTTP ${res.status} for ${symbol}`);
        continue;
      }
      if (!res.ok) throw new PermanentError(`kline HTTP ${res.status} for ${symbol}`);
      const body = (await res.json()) as {
        retCode: number;
        retMsg: string;
        result?: { list?: string[][] };
      };
      if (body.retCode !== 0) {
        if (RETRY_CODES.has(body.retCode)) {
          lastErr = new Error(`kline ${symbol}: ${body.retMsg}`);
          continue;
        }
        throw new PermanentError(`kline ${symbol}: ${body.retMsg} (code ${body.retCode})`);
      }
      return (body.result?.list ?? []).map((k) => ({
        t: Number(k[0]),
        o: +k[1],
        h: +k[2],
        l: +k[3],
        c: +k[4],
      }));
    } catch (e) {
      if (e instanceof PermanentError) throw e;
      lastErr = e; // network error or timeout: retry
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** One UTC day of 1m candles: 1440 minutes, two requests. */
async function fetchDay(
  symbol: string,
  dayStart: number,
  o: Required<Omit<CandleSourceOptions, "cacheDir">>,
): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  for (let s = dayStart; s < dayStart + DAY; s += 1000 * M) {
    const e = Math.min(s + 1000 * M, dayStart + DAY) - 1;
    for (const k of await fetchPage(symbol, s, e, o))
      if (k.t >= dayStart && k.t < dayStart + DAY) out.set(k.t, k);
    await o.sleep(o.pauseMs);
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

export function candleSource(opts: CandleSourceOptions = {}) {
  const o = {
    fetchImpl: opts.fetchImpl ?? (fetch as unknown as FetchLike),
    now: opts.now ?? Date.now,
    pauseMs: opts.pauseMs ?? 120,
    maxAttempts: opts.maxAttempts ?? 4,
    baseBackoffMs: opts.baseBackoffMs ?? 500,
    sleep: opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const cacheDir =
    opts.cacheDir === undefined
      ? (process.env.COURT_CANDLE_CACHE ?? ".court-cache/candles")
      : opts.cacheDir;
  const stats = { cachedDays: 0, fetchedDays: 0, requests: 0 };

  async function day(symbol: string, dayStart: number): Promise<Candle[]> {
    const file = cacheDir
      ? path.join(cacheDir, symbol, `${new Date(dayStart).toISOString().slice(0, 10)}.json`)
      : null;
    if (file) {
      try {
        const cached = JSON.parse(await readFile(file, "utf8")) as Candle[];
        stats.cachedDays++;
        return cached;
      } catch {
        // not cached yet
      }
    }
    const ks = await fetchDay(symbol, dayStart, o);
    stats.fetchedDays++;
    stats.requests += 2;
    // Only a fully closed day is immutable. A day with no candles at all is
    // not cached either: the symbol may not have been listed yet.
    if (file && dayStart + DAY <= o.now() - 5 * M && ks.length) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(ks));
      await rename(tmp, file); // atomic: a crash never leaves a half-written day
    }
    return ks;
  }

  /** Candles in [from, to), assembled from whole UTC days. */
  async function get(symbol: string, from: number, to: number): Promise<Candle[]> {
    const out: Candle[] = [];
    for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
      for (const k of await day(symbol, d)) if (k.t >= from && k.t < to) out.push(k);
    }
    return out;
  }

  return { get, stats };
}
