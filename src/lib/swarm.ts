// AI Trading Swarm — browser-side implementation (fixed)
// Streams Binance USDT-M perpetual futures aggTrades via WebSocket,
// runs a swarm of stateless agents, and emits consensus trade proposals.
// PAPER TRADING ONLY — no order execution.

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
  const contributions: Record<string, AgentSignal> = {};
  for (const a of agents) {
    const sig = a.evaluate(prices, vols);
    contributions[a.name] = sig;
    const w = AGENT_WEIGHTS[a.name] ?? 1;
    if (sig.direction === "BUY") buy += sig.confidence * w;
    else if (sig.direction === "SELL") sell += sig.confidence * w;
  }
  const net = buy - sell;
  if (net > threshold) {
    return {
      id: `${symbol}-${time}`,
      symbol,
      direction: "BUY",
      confidence: Math.min(net, 1),
      price,
      time,
      contributions,
    };
  }
  if (net < -threshold) {
    return {
      id: `${symbol}-${time}`,
      symbol,
      direction: "SELL",
      confidence: Math.min(-net, 1),
      price,
      time,
      contributions,
    };
  }
  return null;
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

const STREAMS_PER_CONN = 150;
const SUB_BATCH = 10; // Bybit accepts up to 10 topics per subscribe frame
const EVAL_INTERVAL_MS = 1500;
const PING_INTERVAL_MS = 20_000;
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

  constructor(
    private symbols: string[],
    private events: SwarmEvents = {},
  ) {}

  getState(): SymbolState[] {
    return Array.from(this.state.values());
  }

  start() {
    this.stopped = false;
    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += STREAMS_PER_CONN) {
      chunks.push(this.symbols.slice(i, i + STREAMS_PER_CONN));
    }
    this.totalChunks = chunks.length;
    for (let chunkId = 0; chunkId < chunks.length; chunkId++) {
      this.openSocket(chunks[chunkId], chunkId);
    }
  }

  stop() {
    this.stopped = true;
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
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      if (this.stopped) {
        ws.close();
        return;
      }
      this.connected++;
      this.sockets.push(ws);
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

    ws.onmessage = (ev) => this.handleMessage(ev.data as string);
  }

  private handleMessage(raw: string) {
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

    const proposal = combine(symbol, price, time, pb.toArray(), vb.toArray());
    if (proposal) this.events.onProposal?.(proposal);
  }
}

