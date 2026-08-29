import { describe, expect, it } from "vitest";
import { deriveEdge, EMPTY_EDGE_REPORT, type EdgeReport } from "../edge-model";

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
