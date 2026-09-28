import { describe, expect, it } from "vitest";
import { DEFAULT_MAKER, makerLeg, replayMaker } from "../maker";
import type { Candle, ReplaySignal } from "../replay";
import { runMakerComparison } from "../replay-run.server";
import type { SignalRow } from "../signals";

const M = 60_000;
const H = 3600_000;
const k = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  t: i * M,
  o,
  h,
  l,
  c,
});
const flat = (n: number, p = 100) => Array.from({ length: n }, (_, i) => k(i, p, p, p, p));
const o = { ...DEFAULT_MAKER, maxHoldMs: 4 * H };

describe("maker fills", () => {
  it("does not fill on a touch, only on a trade-through", () => {
    const ks = flat(400);
    ks[2] = k(2, 100, 100, 100, 100); // touches the 100 limit, never below
    expect(makerLeg(1, 100, 0, ks, o)).toEqual({ filled: false });
    ks[3] = k(3, 100, 100, 99.95, 99.97); // trades through
    const leg = makerLeg(1, 100, 0, ks, o)!;
    expect(leg.filled).toBe(true);
    expect(leg.openedAt).toBe(3 * M);
  });

  it("needs at least 1 bp through the limit (queue position)", () => {
    const ks = flat(400);
    ks[2] = k(2, 100, 100, 99.995, 100); // half a bp through: still behind the queue
    expect(makerLeg(1, 100, 0, ks, o)).toEqual({ filled: false });
    expect(makerLeg(1, 100, 0, ks, { ...o, throughBps: 0 })!.filled).toBe(true);
  });

  it("gives up after the fill window", () => {
    const ks = flat(400);
    ks[7] = k(7, 100, 100, 99, 99.5); // through, but after the 5-minute window
    expect(makerLeg(1, 100, 0, ks, o)).toEqual({ filled: false });
  });

  it("checks the stop on the fill candle (adverse selection)", () => {
    const ks = flat(400);
    ks[1] = k(1, 100, 100, 97.5, 97.8); // fills and runs through the 2% stop in the same minute
    const leg = makerLeg(1, 100, 0, ks, o)!;
    expect(leg.exit).toBe("stop");
    expect(leg.cost).toBeCloseTo(0.0002 + 0.00055 + 0.0002);
  });

  it("needs a trade-through for the maker take-profit, and charges maker fees on it", () => {
    const ks = flat(400);
    ks[1] = k(1, 100, 100, 99.9, 100);
    ks[10] = k(10, 103, 104, 103, 104); // touches 104, not through
    ks[11] = k(11, 104, 104, 104, 104);
    const touch = makerLeg(1, 100, 0, ks, o)!;
    expect(touch.exit).not.toBe("target");
    ks[12] = k(12, 104, 104.2, 104, 104.1); // through
    const leg = makerLeg(1, 100, 0, ks, o)!;
    expect(leg.exit).toBe("target");
    expect(leg.cost).toBeCloseTo(0.0004);
    expect(leg.slipCost).toBe(0);
  });
});

describe("replayMaker", () => {
  const sig: ReplaySignal = {
    signalId: "s1",
    symbol: "SOLUSDT",
    side: "BUY",
    score: 0.85,
    entry: 100,
    stopLoss: null,
    takeProfit: null,
    firstSeenAt: 1,
    admitted: false,
    sources: ["conf:>=0.80", "not-executed"],
  };

  it("skips unfilled signals and scores an unfilled mirror as zero", () => {
    const ks = flat(400);
    ks[2] = k(2, 100, 100, 99.9, 99.95); // long fills; price never trades above 100: short mirror unfilled
    for (let i = 3; i < 400; i++)
      ks[i] = k(
        i,
        99.95 - (i - 3) * 0.01,
        99.95 - (i - 3) * 0.01,
        99.95 - (i - 2) * 0.01,
        99.95 - (i - 2) * 0.01,
      );
    const r = replayMaker(sig, ks, o);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trade.flippedNetUsd).toBe(0);
      expect(r.trade.sources).toEqual(["maker:conf:>=0.80", "maker:not-executed"]);
      expect(r.trade.epoch).toBe("signals-maker");
    }
    expect(replayMaker(sig, flat(400), o)).toEqual({ ok: false, why: "unfilled" });
    expect(replayMaker({ ...sig, entry: null }, flat(400), o)).toEqual({
      ok: false,
      why: "no price",
    });
  });
});

describe("runMakerComparison", () => {
  it("judges taker and maker in one session without mixing them", async () => {
    // Oscillating market so limits get filled and brackets resolve.
    const ks: Candle[] = Array.from({ length: 6000 }, (_, i) => {
      const p = 100 * (1 + 0.03 * Math.sin(i / 120));
      const c = 100 * (1 + 0.03 * Math.sin((i + 1) / 120));
      return k(i, p, Math.max(p, c) * 1.0003, Math.min(p, c) * 0.9997, c);
    });
    const events: SignalRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      symbol: "SOLUSDT",
      side: i % 2 ? "BUY" : "SELL",
      confidence: i % 3 === 0 ? 0.85 : 0.72,
      executed: false,
      createdAt: i * 2 * H + 1,
      price: 100 * (1 + 0.03 * Math.sin((i * 120 + 1) / 120)),
    }));
    const run = await runMakerComparison(events, 24, async () => ks, 6000 * M);
    const ids = run.verdicts.map((v) => v.id);
    expect(ids).toEqual(
      expect.arrayContaining(["signals:all", "signals:maker:all", "signals:maker:conf:>=0.80"]),
    );
    const takerAll = run.verdicts.find((v) => v.id === "signals:all")!;
    const makerAll = run.verdicts.find((v) => v.id === "signals:maker:all")!;
    // taker and maker trade sets are disjoint
    expect(takerAll.n).toBeLessThanOrEqual(40);
    expect(makerAll.n).toBe(run.fills["signals:maker:all"].filled);
    expect(run.fills["signals:maker:all"].tried).toBeGreaterThan(0);
    expect(run.costs["signals:all"].feeBps).toBeCloseTo(11);
    expect(run.costs["signals:maker:all"].feeBps).toBeLessThan(11);
  });
});
