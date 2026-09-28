import { describe, expect, it } from "vitest";
import { type Candle, DEFAULT_REPLAY, replaySignal, type ReplaySignal } from "../replay";
import { judgeAll, mulberry32, signFlipP } from "../court";

const M = 60_000;
const flat = (n: number, p = 100, t0 = 0): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * M, o: p, h: p, l: p, c: p }));

const sig = (over: Partial<ReplaySignal> = {}): ReplaySignal => ({
  signalId: "s1",
  symbol: "SOLUSDT",
  side: "BUY",
  score: 0.95,
  entry: 100,
  stopLoss: 98,
  takeProfit: 104,
  firstSeenAt: 5 * M + 1, // mid-candle: entry must wait for the next open
  admitted: true,
  ...over,
});

describe("replaySignal", () => {
  it("enters at the next open after first sight, never earlier", () => {
    const k = flat(200);
    k[6] = { t: 6 * M, o: 101, h: 101, l: 101, c: 101 };
    k[10] = { t: 10 * M, o: 101, h: 106, l: 101, c: 105 };
    const r = replaySignal(sig(), k);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trade.openedAt).toBe(6 * M);
      expect(r.reason).toBe("target");
      // target = 4% from the fill at 101, costs deducted
      const cost = 2 * (DEFAULT_REPLAY.feePerSide + DEFAULT_REPLAY.slipPerSide);
      expect(r.trade.netUsd).toBeCloseTo((0.04 - cost) * 1000, 6);
    }
  });

  it("assumes the stop fills first when one candle touches both", () => {
    const k = flat(200);
    k[8] = { t: 8 * M, o: 100, h: 110, l: 90, c: 100 };
    const r = replaySignal(sig(), k);
    expect(r.ok && r.reason).toBe("stop");
  });

  it("replays the mirrored trade exactly", () => {
    const k = flat(200);
    k[8] = { t: 8 * M, o: 100, h: 100, l: 97, c: 97 }; // long stops out at -2%, short hits nothing yet
    k[9] = { t: 9 * M, o: 97, h: 97, l: 95.5, c: 96 }; // short target at -4% from 100 = 96
    const r = replaySignal(sig(), k);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reason).toBe("stop");
      expect(r.trade.flippedNetUsd! > 0).toBe(true);
    }
  });

  it("does not judge a trade the candles have not resolved", () => {
    const r = replaySignal(sig(), flat(60));
    expect(r).toEqual({ ok: false, why: "unresolved" });
  });

  it("exits at the time limit", () => {
    const r = replaySignal(sig(), flat(3000));
    expect(r.ok && r.reason).toBe("time");
  });

  it("falls back to default brackets and flags them", () => {
    const k = flat(200);
    k[9] = { t: 9 * M, o: 100, h: 104.5, l: 100, c: 104 };
    const r = replaySignal(sig({ stopLoss: null }), k);
    expect(r.ok && r.defaultBrackets).toBe(true);
  });
});

describe("exact direction placebo", () => {
  it("convicts nothing when flipped trades do as well as real ones", () => {
    const rng = mulberry32(3);
    const trades = Array.from({ length: 200 }, (_, i) => {
      const a = (rng() - 0.5) * 80;
      const b = (rng() - 0.5) * 80;
      return {
        id: String(i),
        symbol: "X",
        side: "BUY",
        epoch: "replay",
        sources: ["sigmalui"],
        openedAt: i * 7 * 3600_000,
        closedAt: i * 7 * 3600_000 + 3600_000,
        notional: 1000,
        grossUsd: a / 10,
        netUsd: a / 10 - 1.5,
        flippedNetUsd: b / 10 - 1.5,
      };
    });
    const [v] = judgeAll(trades, [{ id: "h", claim: "c", select: () => true }]);
    expect(v.verdict).toBe("NOT PROVEN");
  });

  it("uses exact flipped outcomes when present", () => {
    const rows = [{ net: 10, gross: 12, flippedNet: 10, episode: 0, closedAt: 0 }];
    // flipping changes nothing, so every placebo draw ties the observed mean
    expect(signFlipP(rows, 200, mulberry32(1))).toBe(1);
  });
});
