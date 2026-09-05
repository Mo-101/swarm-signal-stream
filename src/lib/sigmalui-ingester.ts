// SigmaLui premium signal ingester.
//
// Polls the SigmaLui SuperSignal feed (default https://trading.mostarindustries.com),
// validates each signal's direction and bracket geometry, and forwards the
// admitted ones into the paper broker as ordinary trade proposals. Execution
// stays 100% paper: fills, fees, funding and brackets are all simulated by the
// existing v1r broker pipeline — SigmaLui contributes direction + conviction
// only, recorded under the agent name "sigmalui" so the edge model attributes
// wins/losses to this source separately from the internal agents.
//
// Feed payload is treated as untrusted external data: every field is parsed
// defensively, and anything that fails validation is skipped, never executed.

import type { TradeProposal } from "@/lib/swarm";

export interface SigmaLuiRawSignal {
  id?: string;
  signalId?: string;
  asset?: string;
  symbol?: string;
  futuresPair?: string;
  direction?: string;
  action?: string;
  side?: string;
  score?: number;
  conviction?: number;
  confidence?: number;
  topsis?: number;
  entryPrice?: number;
  entry?: number;
  price?: number;
  stopLoss?: number;
  sl?: number;
  takeProfit?: number;
  tp?: number;
  timestamp?: string | number;
}

export interface SigmaLuiIngesterOptions {
  /** Base URL of the SigmaLui node, e.g. https://trading.mostarindustries.com */
  url: string;
  /** Minimum TOPSIS/conviction score to admit. Default 0.94. */
  minScore?: number;
  /** Poll cadence. Default 30s. */
  intervalMs?: number;
  /** Minimum time between admitted signals for the same symbol. Default 30min. */
  perSymbolCooldownMs?: number;
  /** Symbols the engine actually tracks — signals for anything else are skipped. */
  isTracked?: (symbol: string) => boolean;
  onProposal: (p: TradeProposal, meta: { regime: string }) => void;
  onSignal?: (s: { symbol: string; direction: string; score: number; admitted: boolean; why?: string }) => void;
  onError?: (message: string) => void;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Map a SigmaLui asset/pair to a Bybit linear perp symbol: RENDER → RENDERUSDT, LINKUSDT.P → LINKUSDT. */
export function toPerpSymbol(s: SigmaLuiRawSignal): string | null {
  const pair = (s.futuresPair ?? s.symbol ?? "").toUpperCase().replace(/\.P$/, "");
  if (pair.endsWith("USDT")) return pair;
  const asset = (s.asset ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!asset) return null;
  return asset.endsWith("USDT") ? asset : `${asset}USDT`;
}

/** Normalize direction: BUY/LONG → BUY, SELL/SHORT → SELL. Anything else → null. */
export function toSide(s: SigmaLuiRawSignal): "BUY" | "SELL" | null {
  const d = (s.direction ?? s.action ?? s.side ?? "").toUpperCase();
  if (d === "BUY" || d === "LONG") return "BUY";
  if (d === "SELL" || d === "SHORT") return "SELL";
  return null;
}

export function signalScore(s: SigmaLuiRawSignal): number | null {
  const raw = s.score ?? s.conviction ?? s.confidence ?? s.topsis;
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Validate one raw signal. Returns a normalized proposal-ready record or a
 * rejection reason. Bracket geometry is checked when both brackets exist:
 * LONG needs SL < entry < TP, SHORT needs TP < entry < SL.
 */
export function validateSignal(
  s: SigmaLuiRawSignal,
  minScore: number,
): { ok: true; symbol: string; side: "BUY" | "SELL"; score: number; entry: number; id: string } | { ok: false; why: string } {
  const score = signalScore(s);
  if (score === null) return { ok: false, why: "no score" };
  if (score < minScore) return { ok: false, why: `score ${score.toFixed(4)} < ${minScore}` };
  const side = toSide(s);
  if (!side) return { ok: false, why: `bad direction "${s.direction ?? s.action ?? s.side ?? ""}"` };
  const symbol = toPerpSymbol(s);
  if (!symbol) return { ok: false, why: "no symbol" };
  const entry = num(s.entryPrice ?? s.entry ?? s.price);
  if (!entry) return { ok: false, why: "no entry price" };
  const sl = num(s.stopLoss ?? s.sl);
  const tp = num(s.takeProfit ?? s.tp);
  if (sl && tp) {
    const valid = side === "BUY" ? sl < entry && entry < tp : tp < entry && entry < sl;
    if (!valid) return { ok: false, why: "bracket geometry violated" };
  }
  const id = s.signalId ?? s.id ?? `${symbol}-${side}-${entry}`;
  return { ok: true, symbol, side, score, entry, id };
}

export class SigmaLuiIngester {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Map<string, number>(); // signal id → admitted at
  private lastBySymbol = new Map<string, number>();
  private inFlight = false;
  readonly stats = { polls: 0, admitted: 0, rejected: 0, errors: 0, lastError: null as string | null, lastPollAt: null as number | null };

  constructor(private opts: SigmaLuiIngesterOptions) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const minScore = this.opts.minScore ?? 0.94;
    const cooldown = this.opts.perSymbolCooldownMs ?? 30 * 60_000;
    try {
      const base = this.opts.url.replace(/\/$/, "");
      const res = await fetch(`${base}/api/soul/signals`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      this.stats.polls += 1;
      this.stats.lastPollAt = Date.now();
      if (!res.ok) throw new Error(`SigmaLui signals HTTP ${res.status}`);
      const body = (await res.json()) as { signals?: SigmaLuiRawSignal[] } | SigmaLuiRawSignal[];
      const list = Array.isArray(body) ? body : (body.signals ?? []);
      // Drop ids older than 24h so the dedupe map cannot grow unbounded.
      const cutoff = Date.now() - 24 * 3600_000;
      for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);

      for (const raw of list) {
        const v = validateSignal(raw, minScore);
        if (!v.ok) {
          this.stats.rejected += 1;
          this.opts.onSignal?.({ symbol: raw.asset ?? raw.symbol ?? "?", direction: raw.direction ?? "?", score: signalScore(raw) ?? 0, admitted: false, why: v.why });
          continue;
        }
        if (this.seen.has(v.id)) continue;
        const lastAt = this.lastBySymbol.get(v.symbol) ?? 0;
        if (Date.now() - lastAt < cooldown) continue;
        if (this.opts.isTracked && !this.opts.isTracked(v.symbol)) {
          this.stats.rejected += 1;
          this.opts.onSignal?.({ symbol: v.symbol, direction: v.side, score: v.score, admitted: false, why: "not tracked" });
          continue;
        }
        this.seen.set(v.id, Date.now());
        this.lastBySymbol.set(v.symbol, Date.now());
        this.stats.admitted += 1;
        this.opts.onSignal?.({ symbol: v.symbol, direction: v.side, score: v.score, admitted: true });
        this.opts.onProposal(
          {
            id: `sigmalui-${v.id}`,
            symbol: v.symbol,
            direction: v.side,
            confidence: Math.min(1, v.score),
            price: v.entry,
            time: Date.now(),
            contributions: { sigmalui: { direction: v.side, confidence: Math.min(1, v.score) } },
            agreement: 1,
            dissent: 0,
          },
          { regime: "external|sigmalui" },
        );
      }
    } catch (e) {
      this.stats.errors += 1;
      this.stats.lastError = e instanceof Error ? e.message : "poll failed";
      this.opts.onError?.(this.stats.lastError);
    } finally {
      this.inFlight = false;
    }
  }
}
