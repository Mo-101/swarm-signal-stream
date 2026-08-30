import { describe, expect, it } from "vitest";
import { deriveEdge, EMPTY_EDGE_REPORT, type EdgeReport } from "../edge-model";
import { STRATEGY_EPOCH } from "../strategy-epoch";

function report(trades: number, confidence: EdgeReport["confidence"]): EdgeReport {
  return {
    ...EMPTY_EDGE_REPORT,
    totals: { trades, wins: 0, pnl: 0, expectancy: 0 },
    confidence,
  };
}

describe("confidence calibration", () => {
  it("keeps the baseline until the 100-trade review sample is complete", () => {
    const learned = deriveEdge(
      report(45, [
        { name: "0.8-0.9", trades: 20, wins: 5, pnl: -10, expectancy: -0.5 },
        { name: "0.9-1.0", trades: 25, wins: 8, pnl: -5, expectancy: -0.2 },
      ]),
      0.62,
    );
    expect(learned.minConfidence).toBe(0.62);
  });

  it("keeps the baseline when no mature bucket is profitable", () => {
    const learned = deriveEdge(
      report(100, [
        { name: "0.8-0.9", trades: 40, wins: 10, pnl: -10, expectancy: -0.25 },
        { name: "0.9-1.0", trades: 30, wins: 10, pnl: -5, expectancy: -0.17 },
      ]),
      0.62,
    );
    expect(learned.minConfidence).toBe(0.62);
  });

  it("raises the threshold only to the lowest proven profitable bucket", () => {
    const learned = deriveEdge(
      report(100, [
        { name: "0.6-0.7", trades: 25, wins: 10, pnl: -2, expectancy: -0.08 },
        { name: "0.7-0.8", trades: 25, wins: 15, pnl: 10, expectancy: 0.4 },
        { name: "0.8-0.9", trades: 25, wins: 16, pnl: 12, expectancy: 0.48 },
      ]),
      0.62,
    );
    expect(learned.minConfidence).toBe(0.7);
  });
});

describe("confidence calibration is scoped to the current epoch", () => {
  /**
   * The real failure this guards against. Confidence is not comparable across
   * epochs — v1 saturated on |net|, v3 normalizes to 0.5-1.0 — and on live
   * history v1 sat in 0.7-1.0 while v3 sat in 0.6-0.8. Pooled, the retired
   * scale's profitable high buckets look like the answer, and the threshold
   * lands above anything v3 ever emits. That halts trading rather than
   * tightening it.
   */
  const mixedScaleReport: EdgeReport = {
    ...EMPTY_EDGE_REPORT,
    totals: { trades: 140, wins: 0, pnl: 0, expectancy: 0 },
    // Pooled view: the 0.9-1.0 bucket looks like the obvious floor.
    confidence: [
      { name: "0.6-0.7", trades: 50, wins: 15, pnl: -10, expectancy: -0.2 },
      { name: "0.9-1.0", trades: 40, wins: 21, pnl: 400, expectancy: 10 },
    ],
    confidence_by_epoch: [
      // Retired scale: profitable, but nothing here is reachable any more.
      { epoch: "v1", name: "0.9-1.0", trades: 40, wins: 21, pnl: 400, expectancy: 10 },
      // Current scale: this is the only range the running epoch emits.
      { epoch: STRATEGY_EPOCH, name: "0.6-0.7", trades: 50, wins: 15, pnl: -10, expectancy: -0.2 },
      { epoch: STRATEGY_EPOCH, name: "0.7-0.8", trades: 50, wins: 30, pnl: 150, expectancy: 3 },
    ],
  };

  it("never picks a floor from a retired epoch's scale", () => {
    const learned = deriveEdge(mixedScaleReport, 0.62);
    // 0.9 would be correct on v1's scale and catastrophic on v3's.
    expect(learned.minConfidence).not.toBe(0.9);
    expect(learned.minConfidence).toBe(0.7);
  });

  it("reports the current epoch's own sample, not the pooled one", () => {
    const learned = deriveEdge(mixedScaleReport, 0.62);
    expect(learned.currentEpoch).toBe(STRATEGY_EPOCH);
    // 100 current-epoch trades, not the 140 pooled total.
    expect(learned.currentEpochSample).toBe(100);
    expect(learned.sample).toBe(140);
  });

  it("holds the baseline when the current epoch has too little history", () => {
    const learned = deriveEdge(
      {
        ...EMPTY_EDGE_REPORT,
        totals: { trades: 200, wins: 0, pnl: 0, expectancy: 0 },
        confidence: [{ name: "0.9-1.0", trades: 150, wins: 90, pnl: 900, expectancy: 6 }],
        confidence_by_epoch: [
          { epoch: "v1", name: "0.9-1.0", trades: 150, wins: 90, pnl: 900, expectancy: 6 },
          { epoch: STRATEGY_EPOCH, name: "0.6-0.7", trades: 25, wins: 8, pnl: 30, expectancy: 1.2 },
        ],
      },
      0.62,
    );
    // 25 current-epoch trades is under the 100-trade calibration gate, even
    // though the pooled total is 200.
    expect(learned.minConfidence).toBe(0.62);
    expect(learned.currentEpochSample).toBe(25);
  });

  it("falls back to pooled buckets only on reports predating the split", () => {
    const legacy = deriveEdge(
      report(100, [
        { name: "0.6-0.7", trades: 25, wins: 10, pnl: -2, expectancy: -0.08 },
        { name: "0.7-0.8", trades: 25, wins: 15, pnl: 10, expectancy: 0.4 },
      ]),
      0.62,
    );
    expect(legacy.minConfidence).toBe(0.7);
  });
});
