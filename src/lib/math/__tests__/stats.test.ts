import { describe, expect, it } from "vitest";
import { bucketIsActionable, sampleStats, wilsonInterval, winRateStats } from "../stats";

describe("wilson interval", () => {
  it("is wide at tiny n and never leaves [0,1]", () => {
    const small = wilsonInterval(3, 4);
    expect(small.low).toBeGreaterThan(0);
    expect(small.high).toBeLessThanOrEqual(1);
    const big = wilsonInterval(750, 1000);
    expect(big.high - big.low).toBeLessThan(small.high - small.low);
  });

  it("refuses to call a 3/5 win rate an edge", () => {
    expect(winRateStats(3, 5).provenEdge).toBe(false);
    expect(winRateStats(700, 1000).provenEdge).toBe(true);
  });
});

describe("sample stats", () => {
  it("computes mean and sample sd", () => {
    const s = sampleStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.mean).toBe(5);
    expect(Math.abs(s.sd - 2.13809)).toBeLessThan(1e-4);
  });

  it("marks a noisy zero-mean sample as insignificant", () => {
    const s = sampleStats([10, -10, 12, -11, 9, -8]);
    expect(s.significant).toBe(false);
  });

  it("gates weight updates on sample size AND a CI clear of zero", () => {
    const noisy = Array.from({ length: 30 }, (_, i) => (i % 2 ? 20 : -19));
    expect(bucketIsActionable(noisy, 20).actionable).toBe(false);
    const consistent = Array.from({ length: 30 }, () => 12);
    expect(bucketIsActionable(consistent, 20).actionable).toBe(true);
    expect(bucketIsActionable([12, 12, 12], 20).actionable).toBe(false);
  });
});
