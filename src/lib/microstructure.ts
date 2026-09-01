// Market microstructure layer — real Bybit L2 orderbook, mark price and
// instrument filters, plus the fill math used to simulate realistic executions.
//
// The trade feed (swarm.ts) drives signals across every symbol. This feed is
// deliberately narrow: it subscribes to full depth only for the symbols that
// matter right now (open positions + pending orders + the hottest movers),
// because that is the only place execution realism is needed.

export type Level = [price: number, size: number];

export interface BookSnapshot {
  symbol: string;
  bids: Level[]; // descending price
  asks: Level[]; // ascending price
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  spreadBps: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  updatedAt: number;
}

export interface TickerSnapshot {
  symbol: string;
  mark: number;
  index: number;
  last: number;
  fundingRate: number;
  nextFundingTime: number;
  updatedAt: number;
}

export interface InstrumentFilter {
  symbol: string;
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
  maxOrderQty: number;
  minNotional: number;
  maxLeverage: number;
}

export interface MicroMetrics {
  connected: boolean;
  tracked: number;
  books: number;
  tickers: number;
  messages: number;
  snapshots: number;
  deltas: number;
  resyncs: number;
  reconnects: number;
  lastMessageAt: number | null;
  avgSpreadBps: number;
  filters: number;
}

const WS_URL = "wss://stream.bybit.com/v5/public/linear";
const DEPTH = 50;
const SUB_BATCH = 10;
const PING_INTERVAL_MS = 20_000;
/** A connected depth feed with no frame for this long is treated as dead. */
const MICRO_STALL_MS = 60_000;
/** A socket that never reaches "open" this long after creation is dead. */
const CONNECT_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 15_000;
/** Bybit allows a generous topic count per connection; stay well inside it. */
export const MAX_TRACKED = 60;
/** A book older than this is treated as unusable for execution. */
export const BOOK_STALE_MS = 5_000;

// ─── Instrument filters (tick size / lot size / min notional) ──────────────

export async function fetchInstrumentFilters(
  signal?: AbortSignal,
): Promise<Map<string, InstrumentFilter>> {
  interface Row {
    symbol: string;
    status: string;
    quoteCoin: string;
    contractType: string;
    priceFilter?: { tickSize?: string };
    lotSizeFilter?: {
      qtyStep?: string;
      minOrderQty?: string;
      maxOrderQty?: string;
      minNotionalValue?: string;
    };
    leverageFilter?: { maxLeverage?: string };
  }
  const out = new Map<string, InstrumentFilter>();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://api.bybit.com/v5/market/instruments-info");
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`instruments-info ${res.status}`);
    const json = (await res.json()) as {
      retCode: number;
      retMsg: string;
      result: { list: Row[]; nextPageCursor?: string };
    };
    if (json.retCode !== 0) throw new Error(json.retMsg || "instruments-info failed");
    for (const r of json.result.list) {
      if (r.status !== "Trading" || r.quoteCoin !== "USDT") continue;
      if (r.contractType !== "LinearPerpetual") continue;
      out.set(r.symbol, {
        symbol: r.symbol,
        tickSize: Number(r.priceFilter?.tickSize ?? 0) || 0.0001,
        qtyStep: Number(r.lotSizeFilter?.qtyStep ?? 0) || 0.001,
        minOrderQty: Number(r.lotSizeFilter?.minOrderQty ?? 0) || 0.001,
        maxOrderQty: Number(r.lotSizeFilter?.maxOrderQty ?? 0) || Number.POSITIVE_INFINITY,
        // Bybit's floor for USDT perps is 5 USDT unless the instrument says more.
        minNotional: Number(r.lotSizeFilter?.minNotionalValue ?? 0) || 5,
        maxLeverage: Number(r.leverageFilter?.maxLeverage ?? 0) || 25,
      });
    }
    cursor = json.result.nextPageCursor ?? "";
    if (!cursor) break;
  }
  return out;
}

// ─── Rounding helpers (exchange filters) ──────────────────────────────────

// Tick/lot rounding lives in the canonical math layer; re-exported here so
// existing call sites keep working and there is only ONE implementation.
export { decimalsOf, roundPrice, roundQty } from "@/lib/math/rounding";
import { moveBps } from "@/lib/math/perp";


// ─── Fill math ─────────────────────────────────────────────────────────────

export interface WalkResult {
  /** Volume-weighted average fill price across consumed levels. */
  avgPrice: number;
  /** Quantity actually filled (may be < requested when the book is thin). */
  filled: number;
  /** Number of price levels consumed. */
  levels: number;
  /** True when the visible book ran out before the order was filled. */
  exhausted: boolean;
}

/**
 * Walk a market order through the visible book.
 * BUY lifts asks (ascending), SELL hits bids (descending).
 */
export function walkBook(book: BookSnapshot, side: "BUY" | "SELL", qty: number): WalkResult {
  const levels = side === "BUY" ? book.asks : book.bids;
  let remaining = qty;
  let cost = 0;
  let used = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, size);
    cost += take * price;
    remaining -= take;
    used += 1;
  }
  const filled = qty - remaining;
  return {
    avgPrice: filled > 0 ? cost / filled : 0,
    filled,
    levels: used,
    exhausted: remaining > 1e-12,
  };
}

/**
 * Largest quantity that can be executed without pushing the average fill more
 * than `maxImpactBps` past the touch, also capped at `maxDepthFraction` of the
 * visible depth on that side. This is the depth-aware position-size ceiling.
 */
export function maxExecutableQty(
  book: BookSnapshot,
  side: "BUY" | "SELL",
  maxImpactBps: number,
  maxDepthFraction: number,
): number {
  const levels = side === "BUY" ? book.asks : book.bids;
  if (levels.length === 0) return 0;
  const touch = side === "BUY" ? book.ask : book.bid;
  if (!(touch > 0)) return 0;
  const limit = side === "BUY" ? touch * (1 + maxImpactBps / 10_000) : touch * (1 - maxImpactBps / 10_000);

  let qty = 0;
  let cost = 0;
  let totalQty = 0;
  for (const [price, size] of levels) totalQty += size;

  for (const [price, size] of levels) {
    // Binary-free incremental fill: take as much of this level as keeps the
    // running VWAP inside the impact limit.
    const nextQty = qty + size;
    const nextCost = cost + size * price;
    const nextVwap = nextCost / nextQty;
    const ok = side === "BUY" ? nextVwap <= limit : nextVwap >= limit;
    if (ok) {
      qty = nextQty;
      cost = nextCost;
      continue;
    }
    // Partial take on this level: solve for x where (cost + x*price)/(qty+x) = limit
    const denom = side === "BUY" ? price - limit : limit - price;
    if (denom > 0) {
      const numer = side === "BUY" ? limit * qty - cost : cost - limit * qty;
      const x = numer / denom;
      if (x > 0) qty += Math.min(x, size);
    }
    break;
  }
  return Math.max(0, Math.min(qty, totalQty * maxDepthFraction));
}

/**
 * Fallback execution model when no live book is available: cross a modelled
 * half-spread and add a square-root impact term on the traded notional.
 */
export function modelledFillPrice(
  refPrice: number,
  side: "BUY" | "SELL",
  notional: number,
  spreadBps: number,
  impactCoefficient = 0.6,
): number {
  const half = spreadBps / 2 / 10_000;
  const impact = (impactCoefficient * Math.sqrt(Math.max(notional, 0) / 100_000)) / 100;
  const adverse = half + impact;
  return side === "BUY" ? refPrice * (1 + adverse) : refPrice * (1 - adverse);
}

/** Signed slippage in bps: positive = worse than the reference price. */
export function slippageBps(
  refPrice: number,
  fillPrice: number,
  side: "BUY" | "SELL",
): number {
  if (!(refPrice > 0)) return 0;
  // Canonical definition: adverse move relative to the reference, in bps.
  return -moveBps(refPrice, fillPrice, side);
}

// ─── Live depth + mark feed ───────────────────────────────────────────────

interface RawBook {
  bids: Map<number, number>;
  asks: Map<number, number>;
  updateId: number;
  updatedAt: number;
}

export interface MicroEvents {
  onStatus?: (connected: boolean) => void;
}

export class MicrostructureFeed {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private connectAttemptAt: number | null = null;
  private stopped = false;
  private connectedFlag = false;

  private tracked = new Set<string>();
  private subscribed = new Set<string>();
  private raw = new Map<string, RawBook>();
  private books = new Map<string, BookSnapshot>();
  private tickers = new Map<string, TickerSnapshot>();
  private filters = new Map<string, InstrumentFilter>();

  private messages = 0;
  private snapshots = 0;
  private deltas = 0;
  private resyncs = 0;
  private reconnects = 0;
  private lastMessageAt: number | null = null;

  constructor(private events: MicroEvents = {}) {}

  setFilters(f: Map<string, InstrumentFilter>) {
    this.filters = f;
  }
  filter(symbol: string): InstrumentFilter | null {
    return this.filters.get(symbol) ?? null;
  }

  start() {
    this.stopped = false;
    this.connect();
    // The depth book prices every fill, so losing this feed silently stops
    // trading outright. onclose is not a reliable enough recovery path on its
    // own: a socket the OS tore down may never emit it, and one that stays
    // "open" but silent never emits it at all. Sweep on a timer instead.
    this.watchdogTimer = setInterval(() => this.sweep(), WATCHDOG_INTERVAL_MS);
  }

  /** Force a rebuild when the socket is missing, dead, silent or stuck. */
  private sweep() {
    if (this.stopped || this.reconnectTimer) return;
    const now = Date.now();
    const ws = this.ws;
    const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
    const silent = this.connectedFlag && now - (this.lastMessageAt ?? now) > MICRO_STALL_MS;
    const handshakeStuck =
      !this.connectedFlag &&
      this.connectAttemptAt !== null &&
      now - this.connectAttemptAt > CONNECT_TIMEOUT_MS;
    if (!dead && !silent && !handshakeStuck) return;
    this.reconnects += 1;
    this.rebuild();
  }

  /** Detach the current socket so its late events cannot fight the new one. */
  private rebuild() {
    const ws = this.ws;
    this.ws = null;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.connectedFlag = false;
    this.subscribed.clear();
    this.raw.clear();
    this.books.clear();
    if (ws) {
      try {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      } catch {
        /* the replacement is already on its way up */
      }
    }
    this.events.onStatus?.(false);
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
    this.connectedFlag = false;
    this.subscribed.clear();
  }

  /**
   * Set the hot set of symbols to keep full depth for. Symbols beyond
   * MAX_TRACKED are dropped (earlier entries win — callers pass required
   * symbols such as open positions first).
   */
  track(symbols: string[]) {
    const next = new Set<string>();
    for (const s of symbols) {
      if (next.size >= MAX_TRACKED) break;
      next.add(s);
    }
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const s of next) if (!this.tracked.has(s)) toAdd.push(s);
    for (const s of this.tracked) if (!next.has(s)) toRemove.push(s);
    this.tracked = next;
    if (toRemove.length) this.unsubscribe(toRemove);
    if (toAdd.length) this.subscribe(toAdd);
  }

  getBook(symbol: string, now = Date.now()): BookSnapshot | null {
    const b = this.books.get(symbol);
    if (!b) return null;
    if (now - b.updatedAt > BOOK_STALE_MS) return null;
    return b;
  }
  getTicker(symbol: string): TickerSnapshot | null {
    return this.tickers.get(symbol) ?? null;
  }
  /** Bybit mark price — the price liquidations are actually evaluated on. */
  getMark(symbol: string): number | null {
    const t = this.tickers.get(symbol);
    return t && t.mark > 0 ? t.mark : null;
  }
  getFunding(symbol: string): number | null {
    const t = this.tickers.get(symbol);
    return t && Number.isFinite(t.fundingRate) ? t.fundingRate : null;
  }
  isTracked(symbol: string) {
    return this.tracked.has(symbol);
  }

  getMetrics(): MicroMetrics {
    let spreadSum = 0;
    let n = 0;
    const now = Date.now();
    for (const b of this.books.values()) {
      if (now - b.updatedAt > BOOK_STALE_MS) continue;
      spreadSum += b.spreadBps;
      n += 1;
    }
    return {
      connected: this.connectedFlag,
      tracked: this.tracked.size,
      books: n,
      tickers: this.tickers.size,
      messages: this.messages,
      snapshots: this.snapshots,
      deltas: this.deltas,
      resyncs: this.resyncs,
      reconnects: this.reconnects,
      lastMessageAt: this.lastMessageAt,
      avgSpreadBps: n ? spreadSum / n : 0,
      filters: this.filters.size,
    };
  }

  // ── internals ──

  private topicsFor(symbols: string[]): string[] {
    const out: string[] = [];
    for (const s of symbols) {
      out.push(`orderbook.${DEPTH}.${s}`);
      out.push(`tickers.${s}`);
    }
    return out;
  }

  private send(op: "subscribe" | "unsubscribe", topics: string[]) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < topics.length; i += SUB_BATCH) {
      try {
        ws.send(JSON.stringify({ op, args: topics.slice(i, i + SUB_BATCH) }));
      } catch {
        /* noop */
      }
    }
  }

  private subscribe(symbols: string[]) {
    const fresh = symbols.filter((s) => !this.subscribed.has(s));
    if (fresh.length === 0) return;
    for (const s of fresh) this.subscribed.add(s);
    this.send("subscribe", this.topicsFor(fresh));
  }

  private unsubscribe(symbols: string[]) {
    const live = symbols.filter((s) => this.subscribed.has(s));
    if (live.length === 0) return;
    for (const s of live) {
      this.subscribed.delete(s);
      this.raw.delete(s);
      this.books.delete(s);
    }
    this.send("unsubscribe", this.topicsFor(live));
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.connectAttemptAt = Date.now();

    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        return;
      }
      this.connectedFlag = true;
      this.events.onStatus?.(true);
      this.subscribed.clear();
      this.subscribe(Array.from(this.tracked));
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ op: "ping" }));
          } catch {
            /* noop */
          }
        }
      }, PING_INTERVAL_MS);
    };

    ws.onclose = () => {
      // Superseded by the watchdog — the replacement owns the state now.
      if (this.ws !== ws) return;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.connectedFlag = false;
      this.subscribed.clear();
      this.raw.clear();
      this.books.clear();
      this.events.onStatus?.(false);
      if (this.stopped) return;
      this.reconnects += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), 2500);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.handle(ev.data as string);
    };
  }

  private handle(raw: string) {
    this.messages += 1;
    this.lastMessageAt = Date.now();
    let msg: {
      topic?: string;
      type?: string;
      ts?: number;
      data?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const topic = msg.topic;
    if (!topic) return;
    if (topic.startsWith("orderbook.")) this.handleBook(msg as never);
    else if (topic.startsWith("tickers.")) this.handleTicker(msg as never);
  }

  private handleBook(msg: {
    topic: string;
    type: string;
    ts: number;
    data: { s: string; b: [string, string][]; a: [string, string][]; u: number; seq: number };
  }) {
    const d = msg.data;
    if (!d?.s) return;
    const symbol = d.s;
    let book = this.raw.get(symbol);
    if (msg.type === "snapshot" || !book) {
      if (msg.type !== "snapshot") return; // wait for a snapshot before applying deltas
      book = { bids: new Map(), asks: new Map(), updateId: d.u, updatedAt: msg.ts };
      this.raw.set(symbol, book);
      this.snapshots += 1;
    } else {
      // Bybit resets u to 1 after a service restart — force a resync.
      if (d.u === 1) {
        this.raw.delete(symbol);
        this.books.delete(symbol);
        this.resyncs += 1;
        return;
      }
      this.deltas += 1;
    }

    for (const [p, q] of d.b ?? []) {
      const price = Number(p);
      const size = Number(q);
      if (size === 0) book.bids.delete(price);
      else book.bids.set(price, size);
    }
    for (const [p, q] of d.a ?? []) {
      const price = Number(p);
      const size = Number(q);
      if (size === 0) book.asks.delete(price);
      else book.asks.set(price, size);
    }
    book.updateId = d.u;
    book.updatedAt = msg.ts || Date.now();

    const bids = Array.from(book.bids.entries()).sort((a, b) => b[0] - a[0]) as Level[];
    const asks = Array.from(book.asks.entries()).sort((a, b) => a[0] - b[0]) as Level[];
    if (bids.length === 0 || asks.length === 0) return;
    const bid = bids[0][0];
    const ask = asks[0][0];
    const mid = (bid + ask) / 2;
    let bidDepthUsd = 0;
    let askDepthUsd = 0;
    for (const [p, s] of bids) bidDepthUsd += p * s;
    for (const [p, s] of asks) askDepthUsd += p * s;

    this.books.set(symbol, {
      symbol,
      bids,
      asks,
      bid,
      ask,
      mid,
      spread: ask - bid,
      spreadBps: mid > 0 ? ((ask - bid) / mid) * 10_000 : 0,
      bidDepthUsd,
      askDepthUsd,
      updatedAt: book.updatedAt,
    });
  }

  private handleTicker(msg: {
    topic: string;
    type: string;
    ts: number;
    data: Record<string, string>;
  }) {
    const d = msg.data;
    const symbol = d?.["symbol"];
    if (!symbol) return;
    const prev = this.tickers.get(symbol);
    const num = (key: string, fallback: number) => {
      const v = d[key];
      if (v === undefined || v === "") return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    this.tickers.set(symbol, {
      symbol,
      mark: num("markPrice", prev?.mark ?? 0),
      index: num("indexPrice", prev?.index ?? 0),
      last: num("lastPrice", prev?.last ?? 0),
      fundingRate: num("fundingRate", prev?.fundingRate ?? NaN),
      nextFundingTime: num("nextFundingTime", prev?.nextFundingTime ?? 0),
      updatedAt: msg.ts || Date.now(),
    });
  }
}
