// Exchange-driven funding schedule.
//
// The engine does NOT compute when funding settles. Bybit publishes all three
// values it needs, and this module is the only place they are read:
//
//   fundingInterval   GET /v5/market/instruments-info   settlement period, MINUTES
//   nextFundingTime   GET /v5/market/tickers            the actual next settlement, ms
//   fundingRate       GET /v5/market/tickers            rate for the upcoming settlement
//   fundingRate       GET /v5/market/history-fund-rate  the SETTLED rate, after the fact
//
// The interval is informational ("what schedule is configured?"); the
// authority on *when* is nextFundingTime. A contract that moves from 8h to 4h
// or 1h — Bybit sets these per symbol and can change them dynamically — is
// followed automatically, with no restart, migration or operator action.
//
// The predicted `fundingRate` on the ticker drifts right up to settlement, so
// a boundary is only *provisionally* charged at the live rate; the runtime
// reconciles it against history-fund-rate, which is what was actually settled.

import { DEFAULT_FUNDING_INTERVAL_MS, lastFundingBoundary } from "@/lib/math/perp";

const BYBIT_REST = "https://api.bybit.com";

/** Bybit's shortest published funding period. Anything below this is a bad feed. */
const MIN_INTERVAL_MS = 60_000;
/** Nothing legitimate settles less often than daily. */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Where a rate came from. Only "settled" is final. */
export type RateSource = "settled" | "live" | "default";

export interface FundingSchedule {
  symbol: string;
  /** Settlement period in ms, from the exchange when known. */
  intervalMs: number;
  /** Exchange-reported next settlement, ms epoch. Null until a ticker lands. */
  nextFundingAt: number | null;
  /** Predicted rate for the upcoming settlement, per interval. */
  rate: number | null;
  /** True once the exchange (not the fallback) supplied the interval. */
  intervalFromExchange: boolean;
  /** When this row last changed, ms epoch. */
  updatedAt: number;
}

export interface TickerFunding {
  symbol: string;
  fundingRate?: string | number | null;
  nextFundingTime?: string | number | null;
}

function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function saneInterval(intervalMs: number | null): number | null {
  if (intervalMs === null) return null;
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) return null;
  return intervalMs;
}

/**
 * Per-symbol funding schedule, fed from the exchange and read by the broker.
 *
 * Every method is safe to call for a symbol the clock has never seen: it then
 * degrades to the fixed 8h UTC grid, which is what the engine assumed
 * unconditionally before this module existed.
 */
export class FundingClock {
  private schedules = new Map<string, FundingSchedule>();
  /** Rates confirmed against history-fund-rate, keyed `${symbol}|${at}`. */
  private settled = new Map<string, number>();
  private scheduleChanges = 0;

  private row(symbol: string, now: number): FundingSchedule {
    let s = this.schedules.get(symbol);
    if (!s) {
      s = {
        symbol,
        intervalMs: DEFAULT_FUNDING_INTERVAL_MS,
        nextFundingAt: null,
        rate: null,
        intervalFromExchange: false,
        updatedAt: now,
      };
      this.schedules.set(symbol, s);
    }
    return s;
  }

  /** `fundingInterval` from instruments-info, in MINUTES (Bybit's unit). */
  setIntervalMinutes(symbol: string, minutes: number, now = Date.now()): void {
    const raw = finiteNumber(minutes);
    const ms = saneInterval(raw === null ? null : raw * 60_000);
    if (ms === null) return;
    const s = this.row(symbol, now);
    if (s.intervalMs !== ms) {
      s.intervalMs = ms;
      s.updatedAt = now;
    }
    s.intervalFromExchange = true;
  }

  /**
   * Fold in one ticker row. Returns true when the exchange moved the schedule
   * out from under us — the caller logs it; nothing else has to react.
   */
  applyTicker(t: TickerFunding, now = Date.now()): boolean {
    const s = this.row(t.symbol, now);
    let scheduleMoved = false;

    const next = finiteNumber(t.nextFundingTime);
    if (next !== null && next > 0) {
      if (s.nextFundingAt !== null && next > s.nextFundingAt) {
        // A next-time that is not exactly one interval on from the last one we
        // saw means Bybit re-cut the schedule for this contract.
        const step = next - s.nextFundingAt;
        if (Math.abs(step - s.intervalMs) > 60_000) scheduleMoved = true;
      }
      s.nextFundingAt = next;
      s.updatedAt = now;
    }

    const rate = finiteNumber(t.fundingRate);
    if (rate !== null) {
      s.rate = rate;
      s.updatedAt = now;
    }
    if (scheduleMoved) this.scheduleChanges += 1;
    return scheduleMoved;
  }

  /** Record a rate confirmed by history-fund-rate for one settlement. */
  setSettledRate(symbol: string, at: number, rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.settled.set(`${symbol}|${at}`, rate);
    // Unbounded growth would leak across a long-running VPS session.
    if (this.settled.size > 5_000) {
      const oldest = this.settled.keys().next();
      if (!oldest.done) this.settled.delete(oldest.value);
    }
  }

  /** The rate to charge at one boundary, and how sure we are of it. */
  rateAt(symbol: string, at: number, fallback: number): { rate: number; source: RateSource } {
    const settled = this.settled.get(`${symbol}|${at}`);
    if (settled !== undefined) return { rate: settled, source: "settled" };
    const live = this.schedules.get(symbol)?.rate;
    if (live !== undefined && live !== null) return { rate: live, source: "live" };
    return { rate: fallback, source: "default" };
  }

  intervalMs(symbol: string): number {
    return this.schedules.get(symbol)?.intervalMs ?? DEFAULT_FUNDING_INTERVAL_MS;
  }

  /** Exchange-reported next settlement, or the fallback grid's next boundary. */
  nextFundingAt(symbol: string, now: number): number {
    const s = this.schedules.get(symbol);
    const interval = s?.intervalMs ?? DEFAULT_FUNDING_INTERVAL_MS;
    const next = s?.nextFundingAt ?? null;
    if (next === null) return lastFundingBoundary(now, interval) + interval;
    if (next > now) return next;
    // A stale nextFundingTime (feed down across a settlement) still projects
    // forward correctly, because it stays on the same anchor.
    const missed = Math.ceil((now - next) / interval);
    return next + Math.max(missed, 1) * interval;
  }

  scheduleOf(symbol: string): FundingSchedule | null {
    return this.schedules.get(symbol) ?? null;
  }

  hasLiveRate(symbol: string): boolean {
    const r = this.schedules.get(symbol)?.rate;
    return r !== undefined && r !== null;
  }

  /** Symbols carrying an exchange-supplied rate. */
  liveRateCount(): number {
    let n = 0;
    for (const s of this.schedules.values()) if (s.rate !== null) n += 1;
    return n;
  }

  /**
   * Every settlement strictly after `after` and at or before `now`, oldest
   * first, anchored on the exchange's own nextFundingTime when we have it.
   *
   * Anchoring matters: an 8h contract whose boundaries fall at 01:00 / 09:00 /
   * 17:00 UTC is invisible to a floor(t / 8h) grid, which would charge it at
   * the wrong times and, across a schedule change, charge twice or not at all.
   */
  boundariesBetween(symbol: string, after: number, now: number, cap = 32): number[] {
    if (!(now > after)) return [];
    const s = this.schedules.get(symbol);
    const interval = s?.intervalMs ?? DEFAULT_FUNDING_INTERVAL_MS;
    const anchor = s?.nextFundingAt ?? null;
    const out: number[] = [];

    if (anchor === null) {
      let b = lastFundingBoundary(after, interval) + interval;
      while (b <= now && out.length < cap) {
        out.push(b);
        b += interval;
      }
      return out;
    }

    // Walk the anchored grid {anchor − k·interval} back to just below `after`,
    // then forward. Both loops are bounded so a corrupt anchor cannot spin.
    const stepsBack = Math.ceil((anchor - after) / interval);
    let b = anchor - Math.max(stepsBack, 0) * interval;
    for (let guard = 0; b <= after && guard < cap + 2; guard++) b += interval;
    while (b <= now && out.length < cap) {
      out.push(b);
      b += interval;
    }
    return out;
  }

  snapshot(): FundingSchedule[] {
    return Array.from(this.schedules.values());
  }

  /** How many times the exchange re-cut a schedule this session. */
  getScheduleChanges(): number {
    return this.scheduleChanges;
  }

  /** Distinct settlement periods across the given symbols, for display. */
  intervalMix(symbols: Iterable<string>): Record<string, number> {
    const mix: Record<string, number> = {};
    for (const sym of symbols) {
      mix[formatInterval(this.intervalMs(sym))] =
        (mix[formatInterval(this.intervalMs(sym))] ?? 0) + 1;
    }
    return mix;
  }

  reset(): void {
    this.schedules.clear();
    this.settled.clear();
    this.scheduleChanges = 0;
  }
}

/** "8h", "4h", "1h", "30m" — never hard-code a period in a label again. */
export function formatInterval(intervalMs: number): string {
  const hours = intervalMs / 3_600_000;
  if (hours >= 1) return `${Number(hours.toFixed(2))}h`;
  return `${Math.round(intervalMs / 60_000)}m`;
}

// ─── Exchange reads ────────────────────────────────────────────────────────

/**
 * Per-symbol settlement period, in minutes, from instruments-info. This is the
 * only endpoint that carries it; the ticker does not.
 */
export async function fetchFundingIntervals(signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${BYBIT_REST}/v5/market/instruments-info`);
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`instruments-info ${res.status}`);
    const json = (await res.json()) as {
      retCode: number;
      retMsg: string;
      result: {
        list: Array<{ symbol: string; status: string; fundingInterval?: number | string }>;
        nextPageCursor?: string;
      };
    };
    if (json.retCode !== 0) throw new Error(json.retMsg || "instruments-info failed");
    for (const r of json.result.list) {
      if (r.status !== "Trading") continue;
      const minutes = finiteNumber(r.fundingInterval);
      if (minutes !== null && minutes > 0) out.set(r.symbol, minutes);
    }
    cursor = json.result.nextPageCursor ?? "";
    if (!cursor) break;
  }
  return out;
}

/** Live funding rate + next settlement time for every linear perp. */
export async function fetchFundingTickers(signal?: AbortSignal): Promise<TickerFunding[]> {
  const res = await fetch(`${BYBIT_REST}/v5/market/tickers?category=linear`, { signal });
  if (!res.ok) throw new Error(`tickers ${res.status}`);
  const json = (await res.json()) as {
    retCode?: number;
    retMsg?: string;
    result?: { list?: TickerFunding[] };
  };
  if (json.retCode !== undefined && json.retCode !== 0) {
    throw new Error(json.retMsg || "tickers failed");
  }
  return json.result?.list ?? [];
}

/**
 * Settled rates for every published settlement in [from, to], keyed by
 * timestamp. A boundary missing from the result has NOT been published yet —
 * leave it provisional and ask again. Never guess: a wrong rate applied once
 * is permanent in the ledger.
 */
export async function fetchSettledFundingRates(
  symbol: string,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const url = new URL(`${BYBIT_REST}/v5/market/history-fund-rate`);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);
  // A tolerance either side: Bybit matches on the settlement timestamp, and a
  // boundary computed from a just-updated anchor can be a few ms off.
  url.searchParams.set("startTime", String(Math.max(0, from - 10_000)));
  url.searchParams.set("endTime", String(to + 10_000));
  url.searchParams.set("limit", "200");
  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`history-fund-rate ${res.status}`);
  const json = (await res.json()) as {
    retCode?: number;
    retMsg?: string;
    result?: {
      list?: Array<{ fundingRate?: string; fundingRateTimestamp?: string | number }>;
    };
  };
  if (json.retCode !== undefined && json.retCode !== 0) {
    throw new Error(json.retMsg || "history-fund-rate failed");
  }
  for (const row of json.result?.list ?? []) {
    const ts = finiteNumber(row.fundingRateTimestamp);
    const rate = finiteNumber(row.fundingRate);
    if (ts !== null && rate !== null) out.set(ts, rate);
  }
  return out;
}

/** One settlement's confirmed rate, or null if Bybit has not published it. */
export async function fetchSettledFundingRate(
  symbol: string,
  at: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const rates = await fetchSettledFundingRates(symbol, at, at, signal);
  if (rates.has(at)) return rates.get(at) ?? null;
  // Tolerate sub-second drift between our anchor and Bybit's stamp.
  for (const [ts, rate] of rates) if (Math.abs(ts - at) <= 10_000) return rate;
  return null;
}
