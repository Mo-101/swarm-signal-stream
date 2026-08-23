// AI Trading Swarm — browser-side implementation (fixed)
// Streams Bybit USDT perpetual futures public trades via WebSocket,
// runs a swarm of stateless agents, and emits consensus trade proposals.
// Signal generation only — execution is handled by the paper/live brokers.

export type Direction = "BUY" | "SELL" | "NEUTRAL";

export interface Tick {
  symbol: string;
  price: number;
  quantity: number;
  time: number;
}

export interface AgentSignal {
  direction: Direction;
  confidence: number; // 0..1
}

export interface TradeProposal {
  id: string;
  symbol: string;
  direction: Exclude<Direction, "NEUTRAL">;
  confidence: number;
  price: number;
  time: number;
  contributions: Record<string, AgentSignal>;
  /** Number of agents voting the winning side. */
  agreement?: number;
  /** Number of agents voting the opposite side. */
  dissent?: number;
  /** Weighted conviction of the winning side, before dissent is subtracted. */
  rawConfidence?: number;
  /** Weighted conviction of the opposing side. */
  opposeConfidence?: number;
  /** agreeWeight / (agreeWeight + opposeWeight), 1 = unanimous. */
  consensus?: number;
  /** Expected favourable move over the trade horizon, in bps. */
  expectedMoveBps?: number;
  /** Recent realized volatility of the symbol, in bps. */
  volBps?: number;
}

export interface SymbolState {
  symbol: string;
  lastPrice: number;
  prevPrice: number;
  lastTime: number;
  change1m: number; // actually change over the window (keep for compatibility)
  updates: number;
}

// ─── Ring buffer ──────────────────────────────────────────────────────────
class Ring {
  private buf: number[];
  private idx = 0;
  private full = false;
  constructor(public readonly size: number) {
    this.buf = new Array(size);
  }
  push(v: number) {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.size;
    if (this.idx === 0) this.full = true;
  }
  get length() {
    return this.full ? this.size : this.idx;
  }
  toArray(): number[] {
    if (!this.full) return this.buf.slice(0, this.idx);
    return this.buf.slice(this.idx).concat(this.buf.slice(0, this.idx));
  }
  last(): number | undefined {
    const n = this.length;
    if (n === 0) return undefined;
    return this.buf[(this.idx - 1 + this.size) % this.size];
  }
}

// ─── Agents ───────────────────────────────────────────────────────────────
export interface Agent {
  name: string;
  window: number;
  evaluate(prices: number[], vols: number[]): AgentSignal;
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = (values[i] - e) * k + e;
  return e;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
  return Math.sqrt(v);
}

export const TrendAgent: Agent = {
  name: "Trend",
  window: 60,
  evaluate(prices) {
    if (prices.length < 30) return { direction: "NEUTRAL", confidence: 0 };
    const fast = ema(prices, 12);
    const slow = ema(prices, 26);
    const recent = prices.slice(-14);
    const atr = stddev(recent) || 1;
    const diff = (fast - slow) / atr;
    if (diff > 0.5) return { direction: "BUY", confidence: Math.min(diff / 2, 1) };
    if (diff < -0.5) return { direction: "SELL", confidence: Math.min(-diff / 2, 1) };
    return { direction: "NEUTRAL", confidence: 0 };
  },
};

export const MeanRevAgent: Agent = {
  name: "MeanRev",
  window: 40,
  evaluate(prices) {
    if (prices.length < 20) return { direction: "NEUTRAL", confidence: 0 };
    const w = prices.slice(-20);
    const ma = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = stddev(w);
    if (sd === 0) return { direction: "NEUTRAL", confidence: 0 };
    const last = prices[prices.length - 1];
    const z = (last - ma) / sd;
    if (z < -2) return { direction: "BUY", confidence: Math.min(-z / 3, 1) };
    if (z > 2) return { direction: "SELL", confidence: Math.min(z / 3, 1) };
    return { direction: "NEUTRAL", confidence: 0 };
  },
};

export const BreakoutAgent: Agent = {
  name: "Breakout",
  window: 40,
  evaluate(prices) {
    if (prices.length < 20) return { direction: "NEUTRAL", confidence: 0 };
    const w = prices.slice(-20, -1);
    const hi = Math.max(...w);
    const lo = Math.min(...w);
    const last = prices[prices.length - 1];
    if (last > hi && hi > 0) return { direction: "BUY", confidence: Math.min(((last - hi) / hi) * 100, 1) };
    if (last < lo && lo > 0) return { direction: "SELL", confidence: Math.min(((lo - last) / lo) * 100, 1) };
    return { direction: "NEUTRAL", confidence: 0 };
  },
};

export const MemeAgent: Agent = {
  name: "Meme",
  window: 40,
  evaluate(prices, vols) {
    if (vols.length < 15) return { direction: "NEUTRAL", confidence: 0 };
    const recent = vols.slice(-15);
    const last = recent[recent.length - 1];
    const prior = recent.slice(0, -1);
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (avg === 0) return { direction: "NEUTRAL", confidence: 0 };
    const ratio = last / avg;
    const p = prices.slice(-6);
    const trend = p.length >= 2 ? p[p.length - 1] - p[0] : 0;
    if (ratio > 2.5 && trend > 0) return { direction: "BUY", confidence: Math.min(ratio / 6, 1) };
    if (ratio > 2.5 && trend < 0) return { direction: "SELL", confidence: Math.min(ratio / 6, 1) };
    return { direction: "NEUTRAL", confidence: 0 };
  },
};

export const ALL_AGENTS: Agent[] = [TrendAgent, MeanRevAgent, BreakoutAgent, MemeAgent];
export const AGENT_WEIGHTS: Record<string, number> = {
  Trend: 1.0,
  MeanRev: 0.8,
  Breakout: 0.9,
  Meme: 1.1,
};

/** Apply weights learned from realized trade outcomes (edge feedback loop). */
export function setAgentWeights(weights: Record<string, number>) {
  for (const [name, w] of Object.entries(weights)) {
    if (Number.isFinite(w) && w > 0) AGENT_WEIGHTS[name] = w;
  }
}

// ─── Combiner ─────────────────────────────────────────────────────────────
export function combine(
  symbol: string,
  price: number,
  time: number,
  prices: number[],
  vols: number[],
  agents: Agent[] = ALL_AGENTS,
  threshold = 0.6,
): TradeProposal | null {
  let buy = 0;
  let sell = 0;
  let buyVotes = 0;
  let sellVotes = 0;
  const contributions: Record<string, AgentSignal> = {};
  for (const a of agents) {
    const sig = a.evaluate(prices, vols);
    contributions[a.name] = sig;
    const w = AGENT_WEIGHTS[a.name] ?? 1;
    if (sig.direction === "BUY") {
      buy += sig.confidence * w;
      buyVotes += 1;
    } else if (sig.direction === "SELL") {
      sell += sig.confidence * w;
      sellVotes += 1;
    }
  }
  const net = buy - sell;
  if (Math.abs(net) <= threshold) return null;

  const isBuy = net > 0;
  const agreeWeight = isBuy ? buy : sell;
  const opposeWeight = isBuy ? sell : buy;
  const total = agreeWeight + opposeWeight;
  // Realized volatility of the recent window, expressed in bps of last price.
  const volBps = price > 0 ? (stddev(prices.slice(-20)) / price) * 10_000 : 0;
  // Conviction, normalized by the maximum weight the panel can express.
  // The old `min(|net|, 1)` saturated at 1 for almost every proposal (measured
  // mean 0.93, corr(confidence, pnl) ≈ 0.06), which made confidence useless for
  // sizing AND collapsed every trade into one calibration bucket. Dividing by
  // the total available weight keeps the number monotone in conviction and
  // spread across the 0.5–1.0 band the edge model buckets on.
  const maxWeight = agents.reduce((sum, a) => sum + (AGENT_WEIGHTS[a.name] ?? 1), 0) || 1;
  const conviction = Math.min(Math.abs(net) / maxWeight, 1);
  const confidence = Number((0.5 + 0.5 * conviction).toFixed(4));
  return {
    id: `${symbol}-${time}`,
    symbol,
    direction: isBuy ? "BUY" : "SELL",
    confidence,
    price,
    time,
    contributions,
    agreement: isBuy ? buyVotes : sellVotes,
    dissent: isBuy ? sellVotes : buyVotes,
    rawConfidence: Number(agreeWeight.toFixed(4)),
    opposeConfidence: Number(opposeWeight.toFixed(4)),
    consensus: total > 0 ? Number((agreeWeight / total).toFixed(4)) : 1,
    volBps: Number(volBps.toFixed(2)),
    // Conviction scaled by the size of the moves this market actually makes.
    expectedMoveBps: Number((confidence * volBps * 2).toFixed(2)),
  };
}

// ─── Symbol discovery (Bybit linear USDT perpetuals) ─────────────────────
export async function fetchPerpetualSymbols(signal?: AbortSignal): Promise<string[]> {
  interface Instrument {
    symbol: string;
    contractType: string;
    status: string;
    quoteCoin: string;
  }
  interface Resp {
    retCode: number;
    retMsg: string;
    result: { list: Instrument[]; nextPageCursor?: string };
  }
  const out: string[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://api.bybit.com/v5/market/instruments-info");
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`instruments-info ${res.status}`);
    const data = (await res.json()) as Resp;
    if (data.retCode !== 0) throw new Error(data.retMsg || "instruments-info failed");
    for (const i of data.result.list) {
      if (
        i.status === "Trading" &&
        i.quoteCoin === "USDT" &&
        i.contractType === "LinearPerpetual"
      ) {
        out.push(i.symbol);
      }
    }
    cursor = data.result.nextPageCursor ?? "";
    if (!cursor) break;
  }
  return out;
}

// ─── Stream manager (Bybit public linear trades) ─────────────────────────
export interface SwarmEvents {
  onTick?: (t: Tick) => void;
  onProposal?: (p: TradeProposal) => void;
  onStatus?: (s: { connected: number; total: number }) => void;
}

export interface FeedStat {
  chunkId: number;
  symbols: number;
  state: "connecting" | "open" | "closed";
  messages: number;
  trades: number;
  lastMessageAt: number | null;
  openedAt: number | null;
  reconnects: number;
}

export interface SwarmMetrics {
  exchange: string;
  wsUrl: string;
  connected: number;
  total: number;
  feeds: FeedStat[];
  totalMessages: number;
  totalTrades: number;
  lastMessageAt: number | null;
  evaluations: number;
  proposals: number;
  avgEvalMs: number;
  lastEvalMs: number;
  maxEvalMs: number;
  trackedSymbols: number;
  /** Wall-clock start of this run, for uptime display. */
  startedAt: number | null;
  /** Feeds the watchdog recycled because they went silent while "open". */
  watchdogRestarts: number;
  /** Feeds currently open but silent past the stall threshold. */
  stalledFeeds: number;
}

const STREAMS_PER_CONN = 150;
const SUB_BATCH = 10; // Bybit accepts up to 10 topics per subscribe frame
const EVAL_INTERVAL_MS = 1500;
const PING_INTERVAL_MS = 20_000;
/** An "open" socket with no frame for this long is treated as dead. */
const STALL_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 15_000;
/**
 * A socket that has not reached "open" this long after we created it is
 * treated as dead. Without this a handshake that hangs (flaky link, VPN,
 * happy-eyeballs) parks the chunk in "connecting" forever — readyState stays
 * CONNECTING, so nothing else in the sweep considers it broken.
 */
const CONNECT_TIMEOUT_MS = 30_000;
const WS_URL = "wss://stream.bybit.com/v5/public/linear";


export class SwarmEngine {
  private sockets: WebSocket[] = [];
  private reconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pingTimers = new Map<WebSocket, ReturnType<typeof setInterval>>();
  private priceBuf = new Map<string, Ring>();
  private volBuf = new Map<string, Ring>();
  private state = new Map<string, SymbolState>();
  private lastEval = new Map<string, number>();
  private connected = 0;
  private totalChunks = 0;
  private stopped = false;
  private feedStats = new Map<number, FeedStat>();
  private evaluations = 0;
  private proposalCount = 0;
  private evalMsTotal = 0;
  private lastEvalMs = 0;
  private maxEvalMs = 0;
  /** Symbol chunks kept so the watchdog can rebuild an individual feed. */
  private chunks: string[][] = [];
  private chunkSockets = new Map<number, WebSocket>();
  /** When the current attempt for a chunk was created, to time out handshakes. */
  private chunkAttemptAt = new Map<number, number>();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | null = null;
  private watchdogRestarts = 0;
  private onWake = () => this.sweep();

  constructor(
    private symbols: string[],
    private events: SwarmEvents = {},
  ) {}

  getMetrics(): SwarmMetrics {
    const feeds = Array.from(this.feedStats.values()).sort(
      (a, b) => a.chunkId - b.chunkId,
    );
    let totalMessages = 0;
    let totalTrades = 0;
    let lastMessageAt: number | null = null;
    let stalledFeeds = 0;
    const now = Date.now();
    for (const f of feeds) {
      totalMessages += f.messages;
      totalTrades += f.trades;
      if (f.lastMessageAt && (!lastMessageAt || f.lastMessageAt > lastMessageAt))
        lastMessageAt = f.lastMessageAt;
      if (f.state === "open" && now - (f.lastMessageAt ?? f.openedAt ?? now) > STALL_MS)
        stalledFeeds++;
    }
    return {
      exchange: "Bybit",
      wsUrl: WS_URL,
      connected: this.connected,
      total: this.totalChunks,
      feeds,
      totalMessages,
      totalTrades,
      lastMessageAt,
      evaluations: this.evaluations,
      proposals: this.proposalCount,
      avgEvalMs: this.evaluations ? this.evalMsTotal / this.evaluations : 0,
      lastEvalMs: this.lastEvalMs,
      maxEvalMs: this.maxEvalMs,
      trackedSymbols: this.state.size,
      startedAt: this.startedAt,
      watchdogRestarts: this.watchdogRestarts,
      stalledFeeds,
    };
  }



  getState(): SymbolState[] {
    return Array.from(this.state.values());
  }

  start() {
    this.stopped = false;
    this.startedAt = Date.now();
    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += STREAMS_PER_CONN) {
      chunks.push(this.symbols.slice(i, i + STREAMS_PER_CONN));
    }
    this.chunks = chunks;
    this.totalChunks = chunks.length;
    for (let chunkId = 0; chunkId < chunks.length; chunkId++) {
      this.openSocket(chunks[chunkId], chunkId);
    }
    // A backgrounded tab throttles timers and a suspended laptop kills sockets
    // without firing onclose promptly, so sweep on every wake signal too.
    this.watchdogTimer = setInterval(() => this.sweep(), WATCHDOG_INTERVAL_MS);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.onWake);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onWake);
      window.addEventListener("focus", this.onWake);
    }
  }

  /**
   * Rebuild any feed that is missing, closed, silent past the stall threshold,
   * or stuck mid-handshake. Cheap and idempotent — safe to call on any wake
   * event.
   *
   * The watchdog rebuilds the socket itself rather than calling close() and
   * waiting for onclose to schedule the reconnect. A socket the OS has already
   * torn down does not reliably emit onclose, and when it stayed quiet the
   * chunk was stranded forever: every later sweep saw the same silent socket,
   * called close() on it again, and no reconnect was ever attempted. That
   * killed the whole price feed with the process still healthy-looking —
   * timers ticking, status logs printing, no TCP connections left.
   */
  private sweep() {
    if (this.stopped) return;
    const now = Date.now();
    for (let chunkId = 0; chunkId < this.chunks.length; chunkId++) {
      // A pending reconnect timer already owns this chunk.
      if (this.reconnectTimers.has(chunkId)) continue;
      const st = this.feedStats.get(chunkId);
      const ws = this.chunkSockets.get(chunkId);
      const socketDead =
        !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
      const silent =
        st?.state === "open" &&
        now - (st.lastMessageAt ?? st.openedAt ?? now) > STALL_MS;
      // CONNECTING that never completes: readyState alone never marks this
      // broken, so age the attempt out explicitly.
      const handshakeStuck =
        st?.state === "connecting" &&
        now - (this.chunkAttemptAt.get(chunkId) ?? now) > CONNECT_TIMEOUT_MS;
      if (!socketDead && !silent && !handshakeStuck) continue;
      this.watchdogRestarts++;
      this.rebuildChunk(chunkId);
    }
  }

  /**
   * Force a chunk back onto a fresh socket. The outgoing socket is detached
   * first so its late onclose cannot decrement `connected` or overwrite the
   * replacement's stats.
   */
  private rebuildChunk(chunkId: number) {
    const ws = this.chunkSockets.get(chunkId);
    if (ws) {
      this.chunkSockets.delete(chunkId);
      this.retireSocket(ws);
    }
    this.openSocket(this.chunks[chunkId], chunkId);
  }

  /** Drop a socket from the live set and silence it, best effort. */
  private retireSocket(ws: WebSocket) {
    const ping = this.pingTimers.get(ws);
    if (ping) {
      clearInterval(ping);
      this.pingTimers.delete(ws);
    }
    if (this.sockets.includes(ws)) {
      this.sockets = this.sockets.filter((s) => s !== ws);
      this.connected = Math.max(0, this.connected - 1);
      this.emitStatus();
    }
    try {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    } catch {
      /* the replacement socket is already on its way up */
    }
  }

  stop() {
    this.stopped = true;
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onWake);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onWake);
      window.removeEventListener("focus", this.onWake);
    }
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const t of this.pingTimers.values()) clearInterval(t);
    this.pingTimers.clear();
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    this.sockets = [];
    this.chunkSockets.clear();
    this.chunkAttemptAt.clear();
    this.connected = 0;
    this.events.onStatus?.({ connected: 0, total: 0 });
  }


  private emitStatus() {
    this.events.onStatus?.({
      connected: this.connected,
      total: this.totalChunks,
    });
  }

  private openSocket(chunk: string[], chunkId: number) {
    const existing = this.feedStats.get(chunkId);
    this.feedStats.set(chunkId, {
      chunkId,
      symbols: chunk.length,
      state: "connecting",
      messages: existing?.messages ?? 0,
      trades: existing?.trades ?? 0,
      lastMessageAt: existing?.lastMessageAt ?? null,
      openedAt: null,
      reconnects: existing ? existing.reconnects + 1 : 0,
    });
    const ws = new WebSocket(WS_URL);
    this.chunkSockets.set(chunkId, ws);
    this.chunkAttemptAt.set(chunkId, Date.now());

    /** True once the watchdog has replaced this socket for its chunk. */
    const superseded = () => this.chunkSockets.get(chunkId) !== ws;

    ws.onopen = () => {
      if (this.stopped || superseded()) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        return;
      }
      this.connected++;
      this.sockets.push(ws);
      const st = this.feedStats.get(chunkId);
      if (st) {
        st.state = "open";
        st.openedAt = Date.now();
      }
      this.emitStatus();
      for (let i = 0; i < chunk.length; i += SUB_BATCH) {
        const args = chunk.slice(i, i + SUB_BATCH).map((s) => `publicTrade.${s}`);
        try {
          ws.send(JSON.stringify({ op: "subscribe", args }));
        } catch {
          /* noop */
        }
      }
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ op: "ping" }));
          } catch {
            /* noop */
          }
        }
      }, PING_INTERVAL_MS);
      this.pingTimers.set(ws, ping);
    };

    ws.onclose = () => {
      const ping = this.pingTimers.get(ws);
      if (ping) {
        clearInterval(ping);
        this.pingTimers.delete(ws);
      }
      // A socket the watchdog already replaced must not touch chunk state —
      // its replacement owns the stats, the connected count and the timers.
      if (superseded()) {
        if (this.sockets.includes(ws)) {
          this.sockets = this.sockets.filter((s) => s !== ws);
          this.connected = Math.max(0, this.connected - 1);
          this.emitStatus();
        }
        return;
      }
      const st = this.feedStats.get(chunkId);
      if (st) st.state = "closed";
      this.chunkSockets.delete(chunkId);
      if (this.stopped) return;


      this.connected = Math.max(0, this.connected - 1);
      this.sockets = this.sockets.filter((s) => s !== ws);
      this.emitStatus();

      const existingTimer = this.reconnectTimers.get(chunkId);
      if (existingTimer !== undefined) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(chunkId);
        if (!this.stopped) this.openSocket(chunk, chunkId);
      }, 3000);
      this.reconnectTimers.set(chunkId, timer);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };

    // A late frame from a retired socket must not refresh the replacement's
    // lastMessageAt — that would mask a genuine stall from the watchdog.
    ws.onmessage = (ev) => {
      if (superseded()) return;
      this.handleMessage(ev.data as string, chunkId);
    };
  }

  private handleMessage(raw: string, chunkId: number) {
    const st = this.feedStats.get(chunkId);
    if (st) {
      st.messages += 1;
      st.lastMessageAt = Date.now();
    }
    let parsed: {
      topic?: string;
      data?: Array<{ s: string; p: string; v: string; T: number }>;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed.topic?.startsWith("publicTrade.") || !Array.isArray(parsed.data)) return;
    if (st) st.trades += parsed.data.length;
    for (const trade of parsed.data) {
      this.handleTrade(trade);
    }
  }


  private handleTrade(d: { s: string; p: string; v: string; T: number }) {
    const symbol = d.s;
    const price = parseFloat(d.p);
    const qty = parseFloat(d.v);
    const time = d.T;
    if (!symbol || !Number.isFinite(price) || !Number.isFinite(qty)) return;

    let pb = this.priceBuf.get(symbol);
    if (!pb) {
      pb = new Ring(60);
      this.priceBuf.set(symbol, pb);
    }
    let vb = this.volBuf.get(symbol);
    if (!vb) {
      vb = new Ring(40);
      this.volBuf.set(symbol, vb);
    }
    pb.push(price);
    vb.push(qty * price); // notional volume

    const prev = this.state.get(symbol);
    const windowStart = pb.toArray()[0] ?? price;
    const change1m = windowStart ? ((price - windowStart) / windowStart) * 100 : 0;
    this.state.set(symbol, {
      symbol,
      lastPrice: price,
      prevPrice: prev?.lastPrice ?? price,
      lastTime: time,
      change1m,
      updates: (prev?.updates ?? 0) + 1,
    });
    this.events.onTick?.({ symbol, price, quantity: qty, time });

    const lastE = this.lastEval.get(symbol) ?? 0;
    if (time - lastE < EVAL_INTERVAL_MS) return;
    this.lastEval.set(symbol, time);

    const t0 = performance.now();
    const proposal = combine(symbol, price, time, pb.toArray(), vb.toArray());
    const dt = performance.now() - t0;
    this.evaluations += 1;
    this.evalMsTotal += dt;
    this.lastEvalMs = dt;
    if (dt > this.maxEvalMs) this.maxEvalMs = dt;
    if (proposal) {
      this.proposalCount += 1;
      this.events.onProposal?.(proposal);
    }
  }
}

