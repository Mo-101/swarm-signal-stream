import { describe, expect, it } from "vitest";
import {
  bankruptcyPrice,
  costHurdle,
  fundingIntervalsBetween,
  fundingPayment,
  grossPnl,
  lastFundingBoundary,
  liquidationPrice,
  marginRatio,
  moveBps,
  netBpsOf,
  netPnl,
  roePct,
  roiPct,
  roundTripFeeBps,
  stopPrice,
  takerFee,
  targetPrice,
} from "../perp";
import { UsdLedger, roundPrice, roundQty } from "../rounding";

const TAKER = 0.00055; // Bybit taker
const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("pnl", () => {
  it("is antisymmetric between long and short", () => {
    const long = grossPnl(100, 110, 2, "BUY");
    const short = grossPnl(100, 110, 2, "SELL");
    near(long, 20);
    near(short, -20);
    near(long + short, 0);
  });

  it("nets both taker legs and funding", () => {
    const entryFee = takerFee(100 * 2, TAKER);
    const exitFee = takerFee(110 * 2, TAKER);
    const pnl = netPnl({
      entryPrice: 100,
      exitPrice: 110,
      size: 2,
      side: "BUY",
      entryFee,
      exitFee,
      funding: 0.05,
    });
    near(pnl, 20 - entryFee - exitFee - 0.05);
  });

  it("round-trip fee in bps matches 2x taker", () => {
    near(roundTripFeeBps(TAKER), 11); // 0.055% * 2 = 11 bps
  });

  it("ROI and ROE differ by exactly the leverage factor", () => {
    const notional = 1000;
    const lev = 10;
    const margin = notional / lev;
    near(roiPct(50, notional) * lev, roePct(50, margin));
  });

  it("net bps of notional is scale invariant", () => {
    near(netBpsOf(10, 1000), netBpsOf(100, 10_000));
  });

  it("moveBps signs by side", () => {
    near(moveBps(100, 101, "BUY"), 100);
    near(moveBps(100, 101, "SELL"), -100);
  });
});

describe("funding", () => {
  it("settles on 8h UTC boundaries", () => {
    const t = Date.UTC(2026, 0, 1, 9, 13, 0);
    expect(new Date(lastFundingBoundary(t)).toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(
      fundingIntervalsBetween(Date.UTC(2026, 0, 1, 7, 0), Date.UTC(2026, 0, 1, 17, 0)),
    ).toBe(2);
  });

  it("longs pay a positive rate, shorts receive it", () => {
    near(fundingPayment(1000, 0.0001, "BUY"), 0.1);
    near(fundingPayment(1000, 0.0001, "SELL"), -0.1);
  });
});

describe("margin and liquidation", () => {
  it("long liq sits below entry, short above, and both shrink with leverage", () => {
    const l = liquidationPrice(100, "BUY", 10, 0.005, TAKER);
    const s = liquidationPrice(100, "SELL", 10, 0.005, TAKER);
    expect(l).toBeLessThan(100);
    expect(s).toBeGreaterThan(100);
    near(l + s, 200, 1e-9);
    expect(liquidationPrice(100, "BUY", 25, 0.005, TAKER)).toBeGreaterThan(l);
  });

  it("liq price is strictly safer than bankruptcy price", () => {
    expect(liquidationPrice(100, "BUY", 10, 0.005, TAKER)).toBeGreaterThan(
      bankruptcyPrice(100, "BUY", 10),
    );
  });

  it("margin ratio hits 1 when equity equals maintenance margin", () => {
    near(marginRatio(50, 50), 1);
    expect(marginRatio(50, 0)).toBe(1);
  });
});

describe("stops", () => {
  it("2% SL / 4% TP bracket the fill on the correct sides", () => {
    near(stopPrice(100, "BUY", 0.02), 98);
    near(targetPrice(100, "BUY", 0.04), 104);
    near(stopPrice(100, "SELL", 0.02), 102);
    near(targetPrice(100, "SELL", 0.04), 96);
  });
});

describe("cost hurdle", () => {
  it("sums fees and both slippage legs, then applies the safety margin", () => {
    const h = costHurdle({ takerFeeRate: TAKER, entrySlipBps: 2, exitSlipBps: 3 });
    near(h.totalCostBps, 16);
    near(h.requiredEdgeBps, 24);
  });

  it("ignores funding that pays us", () => {
    const h = costHurdle({
      takerFeeRate: TAKER,
      entrySlipBps: 0,
      exitSlipBps: 0,
      fundingRatePer8h: 0.0001,
      expectedHoldMs: 8 * 3600_000,
      side: "SELL",
    });
    near(h.totalCostBps, 11);
  });
});

describe("rounding", () => {
  it("respects tick and lot sizes", () => {
    near(roundPrice(1.23456, 0.01), 1.23);
    near(roundQty(1.239, 0.1), 1.2);
  });

  it("accumulates 10k micro-amounts without float drift", () => {
    const led = new UsdLedger(0);
    for (let i = 0; i < 10_000; i++) led.add(0.01);
    expect(led.value).toBe(100);
  });
});
