// AI Trading Swarm — browser-side implementation.
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
  change1m: number;
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
    if (last > hi && hi > 0)
      return { direction: "BUY", confidence: Math.min(((last - hi) / hi) * 100, 1) };
    if (last < lo && lo > 0)
      return { direction: "SELL", confidence: Math.min(((lo - last) / lo) * 100, 1) };
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
    // Direction based on short price trend
    const p = prices.slice(-6);
    const trend = p.length >= 2 ? p[p.length - 1] - p[0] : 0;
    if (ratio > 2.5 && trend > 0)
      return { direction: "BUY", confidence: Math.min(ratio / 6, 1) };
    if (ratio > 2.5 && trend < 0)
      return { direction: "SELL", confidence: Math.min(ratio / 6, 1) };
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

// ─── Symbol discovery ─────────────────────────────────────────────────────
export async function fetchPerpetualSymbols(signal?: AbortSignal): Promise<string[]> {
  const res = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo", { signal });
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const data = (await res.json()) as {
    symbols: Array<{
      symbol: string;
      contractType: string;
      status: string;
      quoteAsset: string;
    }>;
  };
  return data.symbols
    .filter(
      (s) =>
        s.contractType === "PERPETUAL" &&
        s.status === "TRADING" &&
        s.quoteAsset === "USDT",
    )
    .map((s) => s.symbol);
}

// ─── Stream manager ───────────────────────────────────────────────────────
export interface SwarmEvents {
  onTick?: (t: Tick) => void;
  onProposal?: (p: TradeProposal) => void;
  onStatus?: (s: { connected: number; total: number }) => void;
}

const STREAMS_PER_CONN = 100;
const EVAL_INTERVAL_MS = 1500;

export class SwarmEngine {
  private sockets: WebSocket[] = [];
  private priceBuf = new Map<string, Ring>();
  private volBuf = new Map<string, Ring>();
  private state = new Map<string, SymbolState>();
  private lastEval = new Map<string, number>();
  private connected = 0;
  private stopped = false;

  constructor(
    private symbols: string[],
    private events: SwarmEvents = {},
  ) {}

  getState(): SymbolState[] {
    return Array.from(this.state.values());
  }

  start() {
    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += STREAMS_PER_CONN) {
      chunks.push(this.symbols.slice(i, i + STREAMS_PER_CONN));
    }
    for (const chunk of chunks) this.openSocket(chunk);
  }

  stop() {
    this.stopped = true;
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    this.sockets = [];
  }

  private openSocket(chunk: string[]) {
    const streams = chunk.map((s) => `${s.toLowerCase()}@aggTrade`).join("/");
    const url = `wss://fstream.binance.com/stream?streams=${streams}`;
    const ws = new WebSocket(url);
    this.sockets.push(ws);

    ws.onopen = () => {
      this.connected++;
      this.events.onStatus?.({ connected: this.connected, total: this.sockets.length });
    };
    ws.onclose = () => {
      this.connected = Math.max(0, this.connected - 1);
      this.events.onStatus?.({ connected: this.connected, total: this.sockets.length });
      if (!this.stopped) {
        setTimeout(() => this.openSocket(chunk), 3000);
        this.sockets = this.sockets.filter((s) => s !== ws);
      }
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
    let parsed: { data?: { s: string; p: string; q: string; T: number } };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const d = parsed.data;
    if (!d) return;
    const symbol = d.s;
    const price = parseFloat(d.p);
    const qty = parseFloat(d.q);
    const time = d.T;
    if (!Number.isFinite(price) || !Number.isFinite(qty)) return;

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
    vb.push(qty * price);

    const prev = this.state.get(symbol);
    const first = pb.toArray()[0] ?? price;
    const change1m = first ? ((price - first) / first) * 100 : 0;
    const next: SymbolState = {
      symbol,
      lastPrice: price,
      prevPrice: prev?.lastPrice ?? price,
      lastTime: time,
      change1m,
      updates: (prev?.updates ?? 0) + 1,
    };
    this.state.set(symbol, next);
    this.events.onTick?.({ symbol, price, quantity: qty, time });

    const lastE = this.lastEval.get(symbol) ?? 0;
    if (time - lastE < EVAL_INTERVAL_MS) return;
    this.lastEval.set(symbol, time);

    const proposal = combine(symbol, price, time, pb.toArray(), vb.toArray());
    if (proposal) this.events.onProposal?.(proposal);
  }
}
